/**
 * 站点签到 — offscreen 侧实现
 *
 * 签到请求必须在 offscreen document 中发出：
 *  - 这里能复用站点实例的统一 request()（含 Cookie / DNR 认证头注入）；
 *  - 与 UserInfo 刷新一样走串行队列，避免并发过高被浏览器/站点拦截；
 *  - 结果按天持久化到 metadata.signInRecords，避免同一天重复签到。
 */
import PQueue from "p-queue";
import { format } from "date-fns";

import {
  ESignInStatus,
  isSignInSuccessful,
  signInSite as runSignIn,
  SIGNIN_EXCLUDED_SITES,
  type ISignInOutcome,
} from "@ptd/site/utils/signin.ts";
import { getDefinedSiteMetadata, type TSiteID } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { getSiteInstance } from "./site.ts";

/** 签到串行队列（与用户信息刷新一致，默认并发 1） */
const signInQueue = new PQueue({ concurrency: 1 });

interface ISignInRecord {
  at: number;
  status: ESignInStatus;
  message: string;
  /** 本次签到获得的积分（站点返回时才有） */
  points?: number;
}

/** 今日日期 key（本地时区） */
function todayKey(): string {
  return format(new Date(), "yyyy-MM-dd");
}

async function readSignInRecords(): Promise<Record<string, Record<string, ISignInRecord>>> {
  const metadataStore = ((await sendMessage("getExtStorage", "metadata")) ?? {}) as IMetadataPiniaStorageSchema;
  const store = metadataStore as IMetadataPiniaStorageSchema & {
    signInRecords?: Record<string, Record<string, ISignInRecord>>;
  };
  store.signInRecords ??= {};
  return store.signInRecords;
}

async function writeSignInRecord(siteId: TSiteID, outcome: ISignInOutcome): Promise<void> {
  const metadataStore = ((await sendMessage("getExtStorage", "metadata")) ?? {}) as IMetadataPiniaStorageSchema;
  const store = metadataStore as IMetadataPiniaStorageSchema & {
    signInRecords?: Record<string, Record<string, ISignInRecord>>;
  };
  store.signInRecords ??= {};
  const day = todayKey();
  store.signInRecords[day] ??= {};
  store.signInRecords[day][siteId] = {
    at: Date.now(),
    status: outcome.status,
    message: outcome.message,
    points: outcome.points,
  };
  // 只保留最近 30 天，避免无限增长
  const days = Object.keys(store.signInRecords).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 30))) {
    delete store.signInRecords[old];
  }
  await sendMessage("setExtStorage", { key: "metadata", value: store });
}

/** 对单个站点签到（带“今日已成功则跳过”的保护） */
export async function signInForSite(siteId: TSiteID, force = false): Promise<ISignInOutcome> {
  return signInQueue.add(async () => {
    logger({ msg: `signInForSite ${siteId}` });

    if (!force) {
      const records = await readSignInRecords();
      const done = records[todayKey()]?.[siteId];
      if (done && isSignInSuccessful({ status: done.status, message: done.message })) {
        return { status: ESignInStatus.already, message: `今日已签到（${done.message}）`, points: done.points } as ISignInOutcome;
      }
    }

    const site = await getSiteInstance<"private">(siteId);
    const outcome = await runSignIn(site);
    await writeSignInRecord(siteId, outcome);
    return outcome;
  });
}

/** 批量签到所有已启用且未离线的私有站点 */
export async function signInAllSites(force = false): Promise<Array<{ siteId: TSiteID; outcome: ISignInOutcome }>> {
  const metadataStore = ((await sendMessage("getExtStorage", "metadata")) ?? {}) as IMetadataPiniaStorageSchema;
  const sites = metadataStore?.sites ?? {};
  const results: Array<{ siteId: TSiteID; outcome: ISignInOutcome }> = [];

  for (const [siteId, config] of Object.entries(sites)) {
    if (config.isOffline) continue;
    // 用户确认无需签到的站点直接跳过
    if (SIGNIN_EXCLUDED_SITES.has(siteId)) continue;
    // 只签私有站点：公开站点的元数据在批量实例化时一并排除
    try {
      const meta = await getDefinedSiteMetadata(siteId as TSiteID);
      if (meta.type !== "private" || meta.isDead) continue;
    } catch {
      // 元数据读取失败时仍尝试签到，由 signInSite 内部给出失败结果
    }
    const outcome = await signInForSite(siteId as TSiteID, force);
    results.push({ siteId: siteId as TSiteID, outcome });
    logger({
      msg: `signIn ${siteId}: ${outcome.status} ${outcome.message}`,
      data: { paths: outcome.paths, elapsedMs: outcome.elapsedMs },
    });
  }

  return results;
}

onMessage("signInSite", async ({ data: { siteId } }) => await signInForSite(siteId));
onMessage("signInAllSites", async ({ data }) => await signInAllSites(data?.force ?? false));
