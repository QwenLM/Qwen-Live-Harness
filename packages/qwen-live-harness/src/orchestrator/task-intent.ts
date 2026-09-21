/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskIntentKind =
  | 'monitor'
  | 'timer'
  | 'narration'
  | 'handoff'
  | 'session'
  | 'update'
  | 'cancel';

type TaskTarget = { id: string; title: string };

const QUOTED_TEXT =
  /"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|`[^`\n]*`/gu;
const QUESTION_OR_REPORT =
  /什么意思|意味着|为什么|怎么会|会怎样|会怎么样|(?:了|过)(?:吗|么|没有)|^(?:是否|是不是|whether\b)|\b(?:why|means?|meaning)\b/iu;
const TASK_STATUS_REPORT =
  /^(?:(?:the|this|that|my|a)\s+)?(?:monitor|timer|task|job|session|build|tests?|agent|workstream)(?:\s+(?:creation|setup|run|execution|update|cancellation))?\s+(?:has|had|is|was|were|already|failed|succeeded|completed|finished)\b|^(?:监控|监测|提醒|定时器|计时器|任务|会话|构建|测试)(?:的)?(?:创建|设置|运行|执行|更新|取消)?(?:已经|已|刚刚|刚才|目前|现在)?(?:成功|失败|完成|结束|停止|取消)/u;
const REPORTED_OR_HYPOTHETICAL =
  /他说|她说|你(?:刚才)?说|我说过|引用|原话|假如|假设|如果我(?:让|要求|请)|\b(?:said|says|told|quoted|reported)\b|\bif (?:i|someone) (?:asked|were|wanted)\b/u;
const TASK_CREATION_KINDS = [
  'monitor',
  'timer',
  'narration',
  'handoff',
  'session',
  'update',
] as const;
const NEGATED_REQUEST =
  /(?:我|你)(?:并)?(?:没有|没|不是)(?:让|叫|要求|请)|不要|别再|不许|不用|无需|\b(?:do not|don't|don’t|never|not to|didn't ask|did not ask)\b/iu;
const EN_TIME =
  /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|sixty|half)(?:[ -](?:a|an))?[ -](?:seconds?|minutes?|hours?|days?)\b|\b(?:at|by) \d{1,2}(?::\d{2})?(?:\s*[ap]m)?\b/iu;
const ZH_TIME =
  /(?:\d+(?:\.\d+)?|[一二三四五六七八九十百两半]+)\s*(?:秒钟?|分钟|小时|天|点)|(?:明天|后天|今晚|明早)/u;

function normalize(request: string): string {
  // Fail closed on oversized/malformed input, rather than silently selecting a
  // command from a truncated transcript.
  if (typeof request !== 'string' || request.length > 4096) return '';
  return request.normalize('NFKC').toLowerCase().trim();
}

function withoutPoliteness(request: string): string {
  return request
    .replace(/^(?:好的?[，, ]*|好[，, ]*)/u, '')
    .replace(/^(?:我想(?:请|让)你|我需要你|我想要你)/u, '')
    .replace(
      /^(?:(?:请|麻烦)(?:你)?|(?:能不能|能否|可否|可以|能)(?:请)?(?:你)?|帮我|帮忙|给我){1,4}\s*/u,
      '',
    )
    .replace(
      /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:help me\s+)?/u,
      '',
    )
    .trim();
}

function imperative(request: string): string {
  return withoutPoliteness(request.replace(QUOTED_TEXT, ''));
}

/**
 * A conservative additional filter, not a complete language-understanding or
 * authorization system. Callers must supply the current authentic user ASR,
 * bind it to the response/one-shot lease, and validate tool arguments separately.
 * Assistant promises, backend text and historical messages are never inputs.
 */
export function hasExplicitTaskIntent(
  request: string,
  kind: TaskIntentKind,
): boolean {
  const source = normalize(request);
  if (!source) return false;
  if (kind === 'cancel') return cancellationObjects(source).length > 0;
  if (NEGATED_REQUEST.test(source) || REPORTED_OR_HYPOTHETICAL.test(source))
    return false;
  // Only explicit conjunctions may introduce another command, and the first
  // clause must itself be an actual task request. A quoted/reporting preface or
  // arbitrary comma is never a route to promote later text into authorization.
  const clauses = source
    .replace(QUOTED_TEXT, '')
    .split(/[；;]|[，,]?\s*(?:同时|并且)\s*|\s+and(?:\s+then)?\s+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (
    clauses.length > 1 &&
    TASK_CREATION_KINDS.some((candidate) =>
      hasSingleTaskIntent(clauses[0]!, candidate),
    )
  )
    return clauses.some((clause) => hasSingleTaskIntent(clause, kind));
  return hasSingleTaskIntent(source, kind);
}

function hasSingleTaskIntent(
  source: string,
  kind: Exclude<TaskIntentKind, 'cancel'>,
): boolean {
  const text = imperative(source);
  if (
    !text ||
    QUESTION_OR_REPORT.test(text) ||
    TASK_STATUS_REPORT.test(text) ||
    /^(?:监控|监测|任务|提醒)(?:是否|是不是)(?:已|正在|启动|停止|创建|开启|结束)/u.test(
      text,
    ) ||
    NEGATED_REQUEST.test(source) ||
    (/^(?:如果|假如|假设|要是|if\b|suppose\b)/u.test(text) &&
      !/就(?:提醒|告诉|通知)我|\b(?:let me know|alert me|notify me|remind me)\b/u.test(
        text,
      ))
  )
    return false;

  switch (kind) {
    case 'monitor':
      return (
        /^(?:再|继续)?(?:帮我)?(?:监控|监测|监听|观察|盯着|看着|听着|监督)(?:一下|一次)?\s*\S+/u.test(
          text,
        ) ||
        /^(?:keep\s+)?(?:watch(?:ing)?|monitor(?:ing)?|listen(?:ing)? for)\s+(?!(?:monitors?|tasks?)\s*[?.!]*$)\S+/u.test(
          text,
        ) ||
        /^(?:create|start|set up)\s+(?:a |an |another )?(?:new )?(?:audio |video |visual )?monitor\s+(?:for|to|that|which)\s+\S+/u.test(
          text,
        ) ||
        /^(?:你|您)?(?:如果|当|只要|一旦|听到|看到|有).+(?:就|时)?(?:提醒|告诉|通知)我/u.test(
          text,
        ) ||
        /^(?:你|您)?听(?:一下)?.+(?:声音|声响|动静).*(?:听到|一旦|如果|有).*(?:提醒|告诉|通知)我/u.test(
          text,
        ) ||
        /^(?:if|when|whenever)\s+.+\b(?:let me know|alert me|notify me|remind me)\b/u.test(
          text,
        )
      );
    case 'timer':
      return (
        (EN_TIME.test(text) || ZH_TIME.test(text)) &&
        (/^(?:(?:设置|设|创建|新建|开)(?:一个|个|一次|另外一个)?).*(?:定时|计时|闹钟|提醒)/u.test(
          text,
        ) ||
          /^(?:(?:\d|[一二三四五六七八九十百两半明后今]).*)?(?:提醒|叫|通知)我/u.test(
            text,
          ) ||
          /^(?:set|start|create)\s+.+\b(?:timer|alarm|reminder)\b/u.test(
            text,
          ) ||
          /^remind me\s+/u.test(text))
      );
    case 'narration':
      return (
        /^(?:用(?:中文|英语|英文|汉语)\s*)?(?:持续|一直|继续|实时|不断)(?:地)?(?:帮我)?(?:描述|解说|讲解|播报|观察).*(?:画面|屏幕|摄像头|视频|变化|场景)/u.test(
          text,
        ) ||
        /^(?:keep|continue)\s+(?:describing|narrating|watching)\s+.*\b(?:screen|scene|camera|video|workspace|view|changes)\b/u.test(
          text,
        ) ||
        /^(?:continuously|continually)\s+(?:describe|narrate)\s+.*\b(?:screen|scene|camera|video|workspace|view|changes)\b/u.test(
          text,
        ) ||
        /^(?:start|create)\s+(?:a |an )?(?:live |continuous )narration\b/u.test(
          text,
        )
      );
    case 'handoff':
      return (
        /^(?:在[^，。!?]{0,50})?(?:创建|新建|修改|修复|编写|写入|生成|克隆|下载|删除|清理|运行|执行|跑|构建|测试|检查|阅读|读取|分析|更新).*(?:代码|仓库|项目|文件|目录|演示文稿|ppt|报告|文档|命令|脚本|测试|bug|应用|网页|程序)/u.test(
          text,
        ) ||
        /^(?:把|将).*(?:代码|仓库|项目|文件|目录|演示文稿|ppt|报告|文档|脚本|测试|应用|程序).*(?:创建|新建|修改|修复|编写|写入|生成|克隆|下载|删除|清理|运行|执行|构建|检查|更新)/u.test(
          text,
        ) ||
        /^(?:让|委托|交给).*(?:后台|智能体|agent|harness|codex|qoder).*(?:执行|完成|处理|运行|检查|做|写|修|看)/u.test(
          text,
        ) ||
        /^(?:also |keep |continue |queue |add )?(?:run(?:ning)?|execute|build|fix|repair|edit|write|create|prepare|retry|convert|clone|download|delete|clean|test|inspect|read|check|search|implement|refactor)\s+.+\b(?:repository|repo|project|code|file|directory|folder|presentation|ppt|report|document(?:ation)?|command|script|tests?|builds?|suite|bug|app|background|terminal|server|service|network)\b/u.test(
          text,
        ) ||
        /^(?:build|fix|repair|implement|refactor|clone)\s+(?!something\b|anything\b|it\s*[?.!]*$)\S.+/u.test(
          text,
        ) ||
        /^(?:also )?update\s+(?!(?:me|us)\b).+\b(?:repository|repo|code|files?|documents?|documentation|configuration|dependencies|changelog)\b/u.test(
          text,
        ) ||
        /^(?:continue|queue|add)\s+.+\b(?:background|build|repository|project|test|command|terminal)\b/u.test(
          text,
        ) ||
        /^ask\s+.+\b(?:background|terminal)\s+agent\s+to\s+\S+/u.test(text)
      );
    case 'session':
      return (
        /^(?:(?:创建|新建|另开)(?:一个|个)?|(?:开启|打开)(?:一个|个)?(?:新|独立|单独|额外|另外)).*(?:会话|任务|智能体|session|agent)/u.test(
          text,
        ) ||
        /^(?:create|open|start)\s+(?:a |an )?(?:new|separate|another|independent|additional|second|third)\s+.*\b(?:session|agent|task|workstream)\b/u.test(
          text,
        )
      );
    case 'update':
      return (
        /^(?:把|将).*(?:任务|监控|提醒|定时|计时|解说).*(?:改成|改为|调整为|更名|重命名)/u.test(
          text,
        ) ||
        /^(?:修改|调整|更改|更新|重命名).*(?:任务|监控|提醒|定时|计时|解说).*(?:名字|名称|频率|间隔|条件|时间|次数|内容|为|成)/u.test(
          text,
        ) ||
        /^(?:change|update|adjust|rename)\s+(?!me\b).+\b(?:monitor|timer|task|reminder|narration)\b.+\b(?:to|name|interval|frequency|condition|duration|every|once)\b/u.test(
          text,
        ) ||
        /^make\s+.+\b(?:monitor|timer|task|reminder|narration)\b\s+(?:repeat|run|trigger|remind)\b/u.test(
          text,
        )
      );
  }
}

function cancellationObjects(source: string): string[] {
  // Keep quoted names, but never promote a quoted/reported command into a new
  // imperative. Splitting a report at a comma could otherwise do exactly that.
  if (
    REPORTED_OR_HYPOTHETICAL.test(source) ||
    [...source.matchAll(QUOTED_TEXT)].some((match) =>
      /取消|停止|关闭|结束|终止|\b(?:cancel|stop|terminate|abort)\b/u.test(
        match[0],
      ),
    ) ||
    /除了|除外|以外|如果|假如|假设|\b(?:except|unless|excluding|if|when|after|before)\b/u.test(
      source,
    )
  )
    return [];
  const clauses = source.split(
    /[，,。.!?！？;；\n]+|\b(?:but|then)\b|但是|而是/u,
  );
  const objects: string[] = [];
  for (const clause of clauses) {
    const text = withoutPoliteness(clause.trim());
    if (
      !text ||
      QUESTION_OR_REPORT.test(text) ||
      TASK_STATUS_REPORT.test(text) ||
      /是否|是不是|\bwhether\b/u.test(text) ||
      /^(?:如果|假如|假设|if\b|when\b)|\b(?:if|when|after|before)\b/u.test(text)
    )
      continue;
    const match =
      /^(?:(?:取消|停止|关闭|结束|终止|中止)\s*|(?:不要再|别再)(?:做|运行|执行)\s*|(?:cancel|stop|terminate|abort)\s+)(.+)$/u.exec(
        text,
      );
    if (!match) continue;
    let object = match[1]!.replace(/^(?:掉|一下)\s*/u, '').trim();
    if (
      NEGATED_REQUEST.test(object) ||
      /^(?:说|讲话|说话|播报|播放|回答|聊天|talking|speaking|playback|announcing|narrating|responding)\b/iu.test(
        object,
      ) ||
      /^(?:说|讲话|说话|播报|播放|回答|聊天)/u.test(object) ||
      /(?:继续做|继续运行|不要停)|\b(?:keep|continue)\b/u.test(object)
    )
      continue;
    object = object
      .replace(/["'“”‘’「」`]/gu, '')
      .replace(/(?:好吗|好么|可以吗|可以么|行吗|行么|吗|么|了|吧)$/u, '')
      .replace(/\s+please$/u, '')
      .trim();
    if (
      object &&
      !/^(?:这个|那个|它|全部|所有|it|this|that|everything|something|please)$/u.test(
        object,
      )
    )
      objects.push(object);
  }
  return objects;
}

function isAllTasks(object: string): boolean {
  return /^(?:(?:所有|全部)(?:的)?(?:任务|作业|子智能体)|all(?: the| my| current)? (?:tasks|jobs|subagents))$/u.test(
    object,
  );
}

function isDeicticTask(object: string): boolean {
  return /^(?:(?:这|这个|当前|刚才那|刚才那个)(?:任务|监控|提醒|定时器|子智能体)|(?:this|that|the current|the previous|the last) (?:task|job|monitor|timer|agent))$/u.test(
    object,
  );
}

function targetName(value: string): string {
  return normalize(value)
    .replace(/\b(?:powerpoint|presentations?|ppt)\b|演示文稿/gu, 'ppt')
    .replace(/^(?:the |my |a |an |名叫|名为|叫做|叫)/u, '')
    .replace(/(?:(?:的)?(?:任务|作业|监控|监测|提醒|定时器|计时器))+$/u, '')
    .replace(/(?:\s+(?:task|job|monitor|timer|reminder))+$/u, '')
    .trim();
}

function objectMatches(object: string, target: TaskTarget): boolean {
  const query = targetName(object);
  const title = targetName(target.title);
  const id = normalize(target.id);
  if (!query) return false;
  if (query === id || (title && query === title)) return true;
  // Only a complete requested name/phrase may match inside a longer title;
  // never search the full transcript, nor let build match rebuild.
  if (
    query.length < 2 ||
    /^(?:任务|监控|提醒|task|job|monitor|timer)$/u.test(query)
  )
    return false;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(
    title,
  );
}

/** Resolve a cancellation only against the trusted current candidate snapshot.
 * Ambiguous names/deictic targets require clarification, never latest-task bias.
 * all=true is broader authority and requires an explicit unqualified all-task
 * request; scoped "all monitors" is insufficient without task-type metadata.
 */
export function cancellationTargetMatches(
  request: string,
  selected: TaskTarget,
  candidates: readonly TaskTarget[],
  all = false,
): boolean {
  if (
    !selected.id ||
    new Set(candidates.map((candidate) => candidate.id)).size !==
      candidates.length ||
    !candidates.some(
      (candidate) =>
        candidate.id === selected.id && candidate.title === selected.title,
    )
  )
    return false;
  const source = normalize(request);
  if (cancellationWasWithdrawn(source, selected, candidates)) return false;
  const objects = cancellationObjects(source);
  if (objects.some(isAllTasks))
    return (
      objects.length === 1 &&
      !NEGATED_REQUEST.test(source) &&
      !/继续(?:做|运行)|\b(?:keep|continue)\b/u.test(source)
    );
  if (all || objects.length !== 1) return false;
  const object = objects[0]!;
  if (isDeicticTask(object)) return candidates.length === 1;
  const matches = candidates.filter((candidate) =>
    objectMatches(object, candidate),
  );
  return matches.length === 1 && matches[0]!.id === selected.id;
}

function cancellationWasWithdrawn(
  source: string,
  selected: TaskTarget,
  candidates: readonly TaskTarget[],
): boolean {
  if (
    /等等|等一下|算了|撤回|\b(?:wait|hold on|never mind|nevermind|actually no)\b/u.test(
      source,
    )
  )
    return true;
  for (const clause of source.split(
    /[，,。.!?！？;；\n]+|\b(?:but|then)\b|但是|而是/u,
  )) {
    const match =
      /^(?:先别|暂时不要|不要|别|do not\s+|don't\s+|don’t\s+|never\s+)(?:取消|停止|关闭|结束|终止|cancel|stop|terminate|abort)\s*(.*)$/u.exec(
        withoutPoliteness(clause.trim()),
      );
    if (!match) continue;
    const denied = match[1]!
      .replace(/["'“”‘’「」`]/gu, '')
      .replace(/(?:了|吧)$/u, '')
      .trim();
    if (!denied || isAllTasks(denied) || isDeicticTask(denied)) return true;
    const matches = candidates.filter((candidate) =>
      objectMatches(denied, candidate),
    );
    // Unknown/multiple negative scopes require clarification; a clear different
    // object can coexist with the affirmative cancellation (don't stop A, stop B).
    if (matches.length !== 1 || matches[0]!.id === selected.id) return true;
  }
  return false;
}

/** Match only the old task name in an explicit parameter change. New names,
 * trigger conditions and reminder text are data, not update-target authority. */
export function updateTargetMatches(
  request: string,
  selected: TaskTarget,
  candidates: readonly TaskTarget[],
): boolean {
  const source = normalize(request);
  if (
    !hasExplicitTaskIntent(source, 'update') ||
    NEGATED_REQUEST.test(source) ||
    !selected.id ||
    new Set(candidates.map((candidate) => candidate.id)).size !==
      candidates.length ||
    !candidates.some(
      (candidate) =>
        candidate.id === selected.id && candidate.title === selected.title,
    )
  )
    return false;
  const text = withoutPoliteness(source);
  const object =
    /^(?:把|将)(.+?)(?:改成|改为|调整为|更名为|重命名为)/u.exec(text)?.[1] ??
    /^(?:修改|调整|更改|更新|重命名)(.+?)(?:为|成)/u.exec(text)?.[1] ??
    /^(?:change|update|adjust|rename)\s+(.+?)\s+(?:to|so that|such that|from)\s+/u.exec(
      text,
    )?.[1] ??
    /^make\s+(.+?)\s+(?:repeat|run|trigger|remind)\b/u.exec(text)?.[1];
  if (!object) return false;
  const target = object
    .replace(/(?:的)?(?:名字|名称|频率|间隔|条件|时间|次数|内容)$/u, '')
    .replace(
      /(?:'s|’s)?\s+(?:name|interval|frequency|condition|duration)$/u,
      '',
    )
    .replace(/["'“”‘’「」`]/gu, '')
    .trim();
  if (isDeicticTask(target)) return candidates.length === 1;
  const matches = candidates.filter((candidate) =>
    objectMatches(target, candidate),
  );
  return matches.length === 1 && matches[0]!.id === selected.id;
}
