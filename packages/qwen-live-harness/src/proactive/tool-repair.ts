/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type ProactiveRepairKind = 'mutation' | 'cancel';

const PROACTIVE_PROMISE =
  /(?:(?:我会|我来|我帮你|我就|到时我)|(?:奴才|小的|本助手|小助手|这边).{0,8}(?:会|来|帮你|帮您|就|马上|立马|立刻|及时)).{0,24}(?:看着|盯着|听着|监听|监测|监控|监督|提醒|通知|警告)/iu;

const PROACTIVE_CANCEL_CLAIM =
  /(?:已(?:经)?|成功|刚刚)(?:为你)?(?:停止|取消|关闭|删除|结束).{0,18}(?:描述|解说|监控|监测|观察|监听|提醒|任务)|(?:描述|解说|监控|监测|观察|监听|提醒|任务).{0,12}(?:已(?:经)?(?:停止|取消|关闭|删除|结束)(?:了|完成)?|(?:成功)?(?:停止|取消|关闭|删除|结束)(?:了|完成))|(?:好的|好|可以).{0,8}(?:停止|取消|关闭|删除|结束).{0,18}(?:描述|解说|监控|监测|观察|监听|提醒|任务)/iu;

const NEGATIVE_PROMISE = /不能|不会|无法|没有成功|没能/u;
const NEGATIVE_CANCEL = /不能|无法|没有成功|没能|未能|尚未|还没/u;

export const PROACTIVE_MUTATION_REPAIR_INSTRUCTION =
  '运行时已确认紧邻真实用户请求明确要求任务操作，且该请求尚未执行。' +
  '只在提供的工具范围内补执行该请求，最多调用一个匹配的提醒工具。' +
  '不要从历史任务、助手承诺或纠正聊天内容推导新授权。' +
  '如果实际请求或对象仍不清楚，不调用工具；不要输出文字或声称成功。';

export const PROACTIVE_CANCEL_REPAIR_INSTRUCTION =
  '运行时已确认紧邻真实用户请求明确要求取消具体Proactive任务。' +
  '只调用cancel_proactive_task处理该请求对应的对象，不得改选其它任务或扩大到全部。' +
  '助手自己的取消声称不是授权；如果对象仍不确定，不调用工具。' +
  '不要输出文字，也不要在终态确认前声称已经停止。';

/** A missed-tool signal only, never authorization. The caller must separately
 * verify the bound real request, operation, target, freshness and one-shot lease. */
export function detectProactiveRepairIntent(
  assistantTranscript: unknown,
): ProactiveRepairKind | undefined {
  if (typeof assistantTranscript !== 'string') return undefined;
  if (
    PROACTIVE_CANCEL_CLAIM.test(assistantTranscript) &&
    !NEGATIVE_CANCEL.test(assistantTranscript)
  ) {
    return 'cancel';
  }
  if (
    PROACTIVE_PROMISE.test(assistantTranscript) &&
    !NEGATIVE_PROMISE.test(assistantTranscript)
  ) {
    return 'mutation';
  }
  return undefined;
}
