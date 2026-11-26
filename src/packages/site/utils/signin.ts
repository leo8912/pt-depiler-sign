/**
 * 站点签到引擎
 *
 * 接口数据来源：jxxghp/MoviePilot-Plugins 的 AutoSignIn 插件（plugins/autosignin/），
 * 这是目前覆盖本站这些 PT 站点最完整的公开签到实现，避免凭空编造 attendance.php。
 *
 * 设计：
 *  - 一套“通用回退”逻辑（对应 AutoSignIn 的 __signin_base）：GET {站点}/attendance.php，
 *    依据登录状态与“已签/签到已得”等关键字判定；
 *  - 若干“特例”处理器（对应 AutoSignIn sites/*.py）：btschool / hdarea / hdcity /
 *    mteam / pter / pttime / ttg(totheglory) / sunnypt。
 *
 * 本模块只依赖站点实例的 request() 方法，因此与平台解耦，可在 offscreen 中直接调用。
 * request() 会沿用插件统一的网络栈（含 Cookie / DNR 注入的认证头），无需手动拼 Cookie。
 *
 * 注意：这里不发起登录，只做签到；判定“Cookie 失效”时由调用方决定是否触发刷新。
 */

import type { AxiosRequestConfig, AxiosResponse } from "axios";

/** 签到结果状态 */
export enum ESignInStatus {
  success = "success", // 本次签到成功
  already = "already", // 今日已签到（视为成功）
  failed = "failed", // 签到失败
  unsupported = "unsupported", // 站点暂不支持 / 缺少必要配置
}

export interface ISignInOutcome {
  status: ESignInStatus;
  message: string;
  /** 本次签到实际请求的 URL（用于加载后验证签到路径是否正确） */
  paths?: string[];
  /** 本次签到耗时（毫秒） */
  elapsedMs?: number;
  /** 本次签到获得的积分/魔力（站点返回时才有） */
  points?: number;
}

/** 站点实例的最小接口，PrivateSite / BittorrentSite 均满足 */
export interface ISignInSite {
  readonly url: string;
  readonly metadata: { id: string; name?: string };
  readonly userConfig?: { inputSetting?: Record<string, string>; [key: string]: any };
  request<T = any>(config: AxiosRequestConfig, checkLogin?: boolean): Promise<AxiosResponse<T>>;
}

type TSignInHandler = (site: ISignInSite, base: string) => Promise<ISignInOutcome>;

const ok = (message: string, points?: number): ISignInOutcome => ({ status: ESignInStatus.success, message, points });
const already = (message: string, points?: number): ISignInOutcome => ({ status: ESignInStatus.already, message, points });
const failed = (message: string): ISignInOutcome => ({ status: ESignInStatus.failed, message });
const unsupported = (message: string): ISignInOutcome => ({ status: ESignInStatus.unsupported, message });

/**
 * 从签到响应文本中提取“本次获得的积分/魔力”。
 * 各站说法不同：获得 10 个魔力值 / 获得了88魔力值奖励 / 奖励13积分 /
 * Got extra 18 bonus points / Bonus earned today: 612 / 获得 200 克猫粮。
 * 解析不到时返回 undefined（此时 UI 不显示积分数字，只显示“已签到”）。
 */
function extractPoints(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const patterns = [
    /(?:获得|奖励|签到得|得到|Got extra)[^0-9]{0,12}([\d,]+(?:\.\d+)?)/i,
    /([\d,]+(?:\.\d+)?)\s*(?:个)?\s*(?:魔力|积分|猫粮|冰晶|金币|电力|憨豆)/,
    /(?:earned today:|Bonus earned today:)\s*([\d,]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}

/** 去掉结尾斜杠，便于拼接路径 */
function trimBase(url: string): string {
  return (url || "").replace(/\/+$/, "");
}

/** 把 axios 响应体转成可做关键字匹配的文本 */
function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof Document !== "undefined" && data instanceof Document) {
    return data.documentElement?.outerHTML ?? "";
  }
  try {
    return JSON.stringify(data ?? "");
  } catch {
    return "";
  }
}

/**
 * 原始请求：绕开站点 request() 对 4xx/5xx 与 Cloudflare 的抛错，拿响应做判定。
 * checkLogin 固定传 false —— 签到接口常常返回重定向或简版页面，不应触发 NeedLoginError。
 */
/** 当前签到流程实际请求的 URL 列表（签到队列串行，安全） */
let requestLog: string[] = [];

let lastRequestError = "";
let currentBase = ""; // 当前站点主页 URL，用作兜底基址

/** 原生 fetch 的轻量响应结构 */
interface RawResponse {
  status: number;
  data: unknown;
  config?: { url?: string };
}

/**
 * 签到底层请求：用原生 fetch（带 credentials 与站点同源 Origin/Referer）。
 * 不用 site.request()/axios：浏览器会给扩展的跨域 XHR 自动加 chrome-extension:// Origin，
 * hdarea 等站点校验 Origin 不匹配会返回 "403 Forbidden: Origin mismatch"；
 * 原生 fetch 可显式覆盖 Origin，实测可正常签到。扩展 host_permissions 保证跨域响应可读。
 */
async function requestRaw(site: ISignInSite, config: AxiosRequestConfig): Promise<RawResponse | null> {
  const rawUrl = String(config.url ?? "/");
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : new URL(rawUrl, currentBase || site.url).toString();
  requestLog.push(url);
  let origin = currentBase;
  try { origin = new URL(url).origin; } catch { /* 用 currentBase 兜底 */ }
  const headers: Record<string, string> = { Referer: origin + "/", Origin: origin };
  if (config.headers && typeof config.headers === "object") {
    for (const [k, v] of Object.entries(config.headers as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (lk === "origin" || lk === "referer" || v == null) continue;
      headers[k] = String(v);
    }
  }
  const method = (config.method || "GET").toUpperCase();
  const init: RequestInit = { method, headers, credentials: "include" };
  if (config.data != null) {
    init.body = typeof config.data === "string" ? config.data : JSON.stringify(config.data);
  }
  try {
    const resp = await fetch(url, init);
    let data: unknown;
    if (config.responseType === "json") {
      try { data = await resp.json(); } catch { data = await resp.text(); }
    } else {
      data = await resp.text();
    }
    return { status: resp.status, data, config: { url } };
  } catch (e) {
    lastRequestError = (e as Error)?.message || (e as Error)?.name || String(e);
    return null;
  }
}

async function fetchText(site: ISignInSite, url: string, config: AxiosRequestConfig = {}): Promise<string | null> {
  const res = await requestRaw(site, { url, responseType: "text", ...config });
  return res ? toText(res.data) : null;
}

/** 统一的“登录是否失效”判定 */
function isLoggedOut(text: string | null): boolean {
  return !text || /login\.php|[?&]login|请重新登录|登录已过期/i.test(text);
}

// ---------------------------------------------------------------------------
// 通用回退（对应 AutoSignIn.__signin_base）
// ---------------------------------------------------------------------------
async function signInGeneric(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const target = /attendance\.php(?:\?|$)/i.test(base) ? base : base + "/attendance.php";
  const res = await requestRaw(site, { url: target, responseType: "text" });
  if (!res) return failed("签到失败：无法访问签到接口");

  const text = toText(res.data);
  if (isLoggedOut(text)) return failed("签到失败：Cookie 已失效或站点不可达");

  // Turnstile/人机验证表单：GET 只拿到签到表单页，必须过验证才能签到，扩展无法自动完成。
  // 不能把表单里的规则说明文字（“首次签到获得 10 个魔力值”）误判为签到成功。
  if (/cf-turnstile-response|TurnstileCallback|cf-turnstile|__cf_chl|challenge-platform/i.test(text)) {
    return unsupported("该站点签到需人机验证（Turnstile），无法自动签到");
  }

  // 已签判定优先于状态码
  if (/已签|签到已得|已经签到|请勿重复/i.test(text)) return already("今日已签到", extractPoints(text));

  // AutoSignIn 认为 200/500/403 且页面为已登录状态即视为签到（模拟登录）成功
  if ([200, 500, 403].includes(res.status)) return ok("签到成功", extractPoints(text));
  return failed("签到失败：状态码 " + res.status);
}

// ---------------------------------------------------------------------------
// 特例处理器（对应 AutoSignIn sites/*.py）
// ---------------------------------------------------------------------------

/**
 * btschool：请求 index.php?action=addbonus。
 * 实测（2026-11-26）：签到后首页仍显示“每日签到”，不能靠该文本判定已签；
 * 该接口幂等，重复请求不会重复加魔力，因此只要请求后仍在登录态即视为成功。
 */
async function signInBtschool(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const home = await fetchText(site, base);
  if (isLoggedOut(home)) return failed("签到失败：Cookie 已失效或站点不可达");
  const after = await fetchText(site, base + "/index.php?action=addbonus");
  if (isLoggedOut(after)) return failed("签到失败：签到接口返回登录页");
  return ok("签到成功", extractPoints(after));
}

/** hdarea：POST sign_in.php，表单 action=sign_in */
async function signInHdarea(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const body = new URLSearchParams({ action: "sign_in" }).toString();
  const res = await requestRaw(site, {
    method: "POST",
    url: base + "/sign_in.php",
    data: body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    responseType: "text",
  });
  if (!res) return failed("签到失败：签到接口请求失败（" + lastRequestError + "）");
  const text = toText(res.data);
  if (isLoggedOut(text)) return failed("签到失败：Cookie 已失效");
  if (text.includes("此次签到您获得")) return ok("签到成功", extractPoints(text));
  if (text.includes("请不要重复签到哦")) return already("今日已签到", extractPoints(text));
  return failed("签到失败：未知响应");
}

/**
 * hdcity：GET /sign 即完成签到（幂等）。
 * 实测（2026-11-26）：站点已改版为英文界面，返回
 *   "Checked in" / "Already checked in today. Got extra 18 bonus points." / "Bonus earned today: 612"。
 * 旧实现的中文关键字已失效，这里兼容中英文；"Already checked in" 优先于 "Checked in" 判定。
 */
async function signInHdcity(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const text = await fetchText(site, base + "/sign");
  if (isLoggedOut(text)) return failed("签到失败：Cookie 已失效或站点不可达");
  if (/Already checked in today|已签到/.test(text!)) return already("今日已签到", extractPoints(text));
  if (/Checked in|Got extra|Bonus earned today|本次签到获得魅力/.test(text!)) return ok("签到成功", extractPoints(text));
  return failed("签到失败：未知响应");
}

/**
 * m-team：站点没有签到机制，打开首页保持活跃即可。
 * 不需要 token，也不调用签到接口（用户确认直接打开就行）。
 */
async function signInMteam(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const text = await fetchText(site, base);
  if (isLoggedOut(text)) return failed("打开失败：Cookie 已失效或站点不可达");
  return ok("已打开站点（保持活跃）");
}

/** pter：GET attendance-ajax.php，返回 JSON {status} */
async function signInPter(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const text = await fetchText(site, base + "/attendance-ajax.php");
  if (isLoggedOut(text)) return failed("签到失败：Cookie 已失效或站点不可达");
  try {
    const data = JSON.parse(text!) as { status?: string; message?: string };
    if (data.status === "1") return ok("签到成功", extractPoints(data.message ?? text));
    if (data.status === "0") return already("今日已签到", extractPoints(data.message ?? text));
  } catch {
    // 落到下面的失败
  }
  return failed("签到失败：签到接口返回数据异常");
}

/**
 * pttime：GET attendance.php?type=sign&uid=<uid>。
 * 实测（2026-11-26）：裸 attendance.php 会返回“拒绝访问：已签到，无需再签”，
 * 真正的签到链接带 type=sign&uid 参数，uid 需从首页签到链接提取。
 */
async function signInPttime(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const home = await fetchText(site, base);
  if (isLoggedOut(home)) return failed("签到失败：Cookie 已失效或站点不可达");
  const uid = home?.match(/attendance\.php\?type=sign&(?:amp;)?uid=(\d+)/i)?.[1];
  // 已签到后首页签到链接会变成“签到详情”(attendance.php?type=list)，此时视为已签
  if (!uid) {
    if (/type=list|签到详情|已签到/.test(home ?? "")) return already("今日已签到");
    return failed("签到失败：无法从首页获取签到 uid");
  }
  const text = await fetchText(site, base + `/attendance.php?type=sign&uid=${uid}`);
  if (isLoggedOut(text)) return failed("签到失败：Cookie 已失效或站点不可达");
  if (text!.includes("签到成功")) return ok("签到成功", extractPoints(text));
  if (/已签|请勿重复|拒绝访问/i.test(text!)) return already("今日已签到", extractPoints(text));
  return failed("签到失败：未知响应");
}

/** totheglory(TTG)：先从首页取 signed_timestamp / signed_token，再 POST signed.php */
async function signInTtg(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  const home = await fetchText(site, base);
  if (isLoggedOut(home)) return failed("签到失败：Cookie 已失效或站点不可达");
  if (/<b style="color:green;">已签到<\/b>|亲，您今天已签到过/i.test(home!)) return already("今日已签到");

  const ts = home!.match(/signed_timestamp:\s*"(\d{10})"/)?.[1];
  const token = home!.match(/signed_token:\s*"([^"]+)"/)?.[1];
  if (!ts || !token) return failed("签到失败：无法获取签到参数");

  const body = new URLSearchParams({ signed_timestamp: ts, signed_token: token }).toString();
  const res = await requestRaw(site, {
    method: "POST",
    url: base + "/signed.php",
    data: body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    responseType: "text",
  });
  if (!res) return failed("签到失败：签到接口请求失败");
  const text = toText(res.data);
  if (text.includes("您已连续签到")) return ok("签到成功", extractPoints(text));
  if (text.includes("亲，您今天已签到过")) return already("今日已签到", extractPoints(text));
  return failed("签到失败：未知响应");
}

/**
 * sunnypt：网页前端签到走独立 API 子域 + Bearer Token（不是集成 API Key）。
 * 实测（2026-11-26）：
 *   1) GET {站点}/api/auth/session （带登录 Cookie）→ { data: { accessToken } }
 *   2) POST https://api.sunnypt.top/api/v1/attendance/check-in
 *      头 Authorization: Bearer <accessToken>
 *   3) 成功返回 { code: 0, data: { days, points } }；已签返回 checked_in:true / “重复”类 msg。
 * 集成 API Key（X-API-Key + /api/v1/mp/）没有签到端点，不能用于签到。
 */
async function signInSunny(site: ISignInSite, base: string): Promise<ISignInOutcome> {
  // 1) 用登录 Cookie 换取前端 accessToken
  const sessionRes = await requestRaw(site, {
    url: base + "/api/auth/session",
    responseType: "json",
    headers: { Accept: "application/json" },
  });
  const token = (sessionRes?.data as { data?: { accessToken?: string } } | undefined)?.data?.accessToken;
  if (!token) return failed("签到失败：无法获取网页登录 Token（可能 Cookie 已失效）");

  // 2) 带 Bearer Token 请求签到
  const res = await requestRaw(site, {
    method: "POST",
    url: "https://api.sunnypt.top/api/v1/attendance/check-in",
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    responseType: "json",
  });
  if (!res) return failed("签到失败：无法访问签到接口");
  const data = res.data as { code?: number; msg?: string; data?: { checked_in?: boolean; days?: number; points?: number } } | undefined;
  if (data?.code === 0) {
    return ok("签到成功", data.data?.points);
  }
  if (data?.data?.checked_in === true || /已签|重复|签过|签到过|已经签到|今天已/i.test(data?.msg ?? "")) return already("今日已签到");
  return failed("签到失败：" + (data?.msg || ("状态码 " + res.status)));
}

/** 站点 id -> 特例处理器；未命中的私有站点走通用回退 */
const HANDLERS: Record<string, TSignInHandler> = {
  btschool: signInBtschool,
  hdarea: signInHdarea,
  hdcity: signInHdcity,
  mteam: signInMteam,
  pter: signInPter,
  pttime: signInPttime,
  totheglory: signInTtg,
  sunnypt: signInSunny,
};

/** 有专属签到实现的站点 id（用于 UI 展示与统计） */
export const SIGNIN_SUPPORTED_SITES = Object.keys(HANDLERS);

/**
 * 明确不支持/不需要签到的站点（用户确认）。
 * audiences 使用爆米花奖励系统（mybonus.php），没有传统签到，排除以免误报失败。
 */
export const SIGNIN_EXCLUDED_SITES = new Set<string>(["audiences", "mteam"]);

/**
 * 对一个站点执行签到。
 * @param site 站点实例（PrivateSite / BittorrentSite）
 */
export async function signInSite(site: ISignInSite): Promise<ISignInOutcome> {
  requestLog = [];
  lastRequestError = "";
  const started = Date.now();
  if (!site?.url) return failed("签到失败：未配置站点地址");
  currentBase = trimBase(site.url);
  if (SIGNIN_EXCLUDED_SITES.has(site.metadata?.id)) {
    return unsupported("该站点无需签到");
  }
  const base = trimBase(site.url);
  const handler = HANDLERS[site.metadata?.id];
  let outcome: ISignInOutcome;
  try {
    outcome = handler ? await handler(site, base) : await signInGeneric(site, base);
  } catch (e) {
    outcome = failed("签到失败：" + ((e as Error)?.message ?? "未知错误"));
  }
  outcome.paths = requestLog.slice();
  outcome.elapsedMs = Date.now() - started;
  return outcome;
}

/** 结果是否算“成功”（签到成功或今日已签到） */
export function isSignInSuccessful(outcome: ISignInOutcome): boolean {
  return outcome.status === ESignInStatus.success || outcome.status === ESignInStatus.already;
}
