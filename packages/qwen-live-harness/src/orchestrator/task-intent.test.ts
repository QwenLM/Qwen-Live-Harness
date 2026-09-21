/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  cancellationTargetMatches,
  hasExplicitTaskIntent,
  updateTargetMatches,
  type TaskIntentKind,
} from './task-intent.js';

const KINDS: TaskIntentKind[] = [
  'monitor',
  'timer',
  'narration',
  'handoff',
  'session',
  'update',
  'cancel',
];

describe('explicit current-user task intent', () => {
  it.each([
    '我帮你纠正',
    '你胡说',
    '我随便说他就跟我开始瞎聊',
    '上下文太少了',
    '别说了',
    '停止播报',
    '换个话题',
    'stop talking',
    '算了',
    'stop',
    'stop it',
    '取消这个',
    'yes',
    '你刚才说会监控',
    '为什么又新建敲桌子提醒',
    '如果你监控我会怎样？',
    'Can you create monitors?',
    '"Fix the bug"是什么意思',
    '我没让你修bug',
    'How would you fix the bug?',
    '他说“取消PPT任务”',
    '我不是让你停止构建',
    'PPT停了吗',
    '取消PPT任务了吗？',
    'Give me an update on the task.',
    'Do not cancel the PPT task.',
    'Please do not fix the bug.',
    'Did the build fail?',
    'Has the task already succeeded?',
    'I already fixed the failed build.',
    'The build failed.',
    'Build failed.',
    'Monitor creation succeeded.',
    'The task already completed.',
    '监控创建已经成功了。',
    '构建失败了。',
    'If I asked you to stop the build task, what would happen?',
  ])('does not authorize a mutation from %s', (request) => {
    for (const kind of KINDS)
      expect(hasExplicitTaskIntent(request, kind), kind).toBe(false);
  });

  it.each<[TaskIntentKind, string]>([
    ['monitor', '听到我敲三下桌子就提醒我'],
    ['monitor', '你听到我敲三下桌子，就提醒我。'],
    ['monitor', '监控水杯是否被移动，同时监控门是否打开，有变化就提醒我。'],
    ['monitor', '监控屏幕是否变红，有变化就提醒我。'],
    ['monitor', 'Monitor whether the window is open and alert me.'],
    ['monitor', '请帮我听敲桌子的声音，听到后提醒我一次。'],
    ['monitor', '如果我咳嗽就提醒我'],
    ['monitor', 'If I cough, let me know.'],
    ['monitor', '再监控一次敲桌子'],
    ['monitor', 'Watch my posture and remind me whenever I slouch.'],
    ['monitor', 'Can you monitor my posture?'],
    ['timer', '5分钟后提醒我喝水'],
    ['timer', '请提醒我五分钟后喝水'],
    ['timer', 'Set a five-minute timer for my tea.'],
    ['timer', 'Set a timer for five minutes for my tea.'],
    ['timer', 'Set another ten-minute timer.'],
    ['timer', 'Remind me at 3 pm to call home.'],
    ['narration', '持续描述新画面'],
    ['narration', '请用英语持续讲解画面。'],
    [
      'narration',
      'Keep describing meaningful workspace changes in brief English.',
    ],
    ['narration', 'Keep watching the screen and describe changes to me.'],
    ['handoff', '请在下载目录创建演示文稿'],
    ['handoff', '请把这个仓库克隆到下载目录。'],
    ['handoff', '请帮我跑一下项目测试。'],
    ['handoff', 'Fix the bug'],
    ['handoff', 'Fix the failed build'],
    ['handoff', 'Repair the failed tests'],
    ['handoff', 'Please run the already installed test suite.'],
    ['handoff', 'Inspect the build that already succeeded.'],
    ['handoff', 'Build a snake game'],
    ['handoff', 'Prepare the requested report'],
    ['handoff', 'Please retry the project check.'],
    ['handoff', 'Please convert the test suite.'],
    ['handoff', 'Please check the server connection.'],
    ['handoff', 'Please update the project documentation.'],
    ['handoff', 'Please also update the project changelog.'],
    ['handoff', 'Update the repository dependencies.'],
    ['handoff', 'Update the configuration file.'],
    ['handoff', 'Please keep running the repository tests.'],
    ['handoff', 'Please also check the documentation.'],
    ['handoff', 'Please add the test command to the running task.'],
    ['handoff', 'Ask a background agent to inspect this screenshot.'],
    ['handoff', 'Please check the weather in the background.'],
    ['session', '新建一个独立的后台会话'],
    ['session', '新建一个后台会话'],
    ['session', '新建一个任务'],
    ['session', '新建一个会话'],
    ['session', '另开一个会话'],
    ['session', 'Create a new background agent session.'],
    ['session', 'Create a second workstream.'],
    ['session', 'Create a new ACP background agent session.'],
    ['update', '把监控任务的间隔改成两秒'],
    ['update', 'Make the posture monitor repeat whenever I slouch.'],
    [
      'update',
      'Change the posture monitor to remind me once when I lean too close to the screen.',
    ],
    ['cancel', '取消PPT任务'],
    ['cancel', 'Stop the build task'],
    ['cancel', '取消刚才那个任务'],
    ['cancel', '能帮我取消PPT任务吗？'],
    ['cancel', '不要再做PPT任务了'],
  ])('recognizes %s from %s', (kind, request) => {
    expect(hasExplicitTaskIntent(request, kind)).toBe(true);
  });

  it.each<[TaskIntentKind, string]>([
    ['monitor', '看下屏幕'],
    ['timer', '如果我咳嗽就提醒我'],
    ['timer', 'Set a timer'],
    ['monitor', '5分钟后提醒我喝水'],
    ['session', 'Continue the background task'],
    ['session', 'Start the task'],
    ['narration', 'Describe this screen'],
    ['narration', 'Keep talking about this task'],
    ['handoff', 'What is the weather today?'],
    ['handoff', 'Write me a poem'],
    ['handoff', 'Explain the bug'],
    ['handoff', 'Update me on the project status.'],
    ['handoff', 'Update us on the project documentation status.'],
    ['handoff', 'Please also update me on the project changelog status.'],
    ['session', 'He said create a second workstream.'],
    ['session', 'Do not create a second workstream.'],
    ['handoff', 'Tell me how to build a game'],
    ['update', 'Update me on the task progress'],
    ['cancel', '停止播报PPT进度，PPT继续做'],
    ['cancel', 'Please stop announcing the build progress.'],
    ['cancel', 'If the build fails, cancel the task.'],
    ['monitor', '请「不要」监控我的屏幕'],
    ['monitor', '请帮我听一下这个录音是什么声音'],
  ])('does not confuse %s with %s', (kind, request) => {
    expect(hasExplicitTaskIntent(request, kind)).toBe(false);
  });

  it('fails closed on empty and oversized transcripts', () => {
    for (const kind of KINDS) {
      expect(hasExplicitTaskIntent('', kind)).toBe(false);
      expect(
        hasExplicitTaskIntent('Fix the bug ' + 'x'.repeat(4096), kind),
      ).toBe(false);
    }
  });

  it.each([
    '帮我盯着窗户，同时五分钟后提醒我喝水',
    'Watch the window and set a five-minute timer for tea',
    '监控水杯是否被移动，同时监控门是否打开，有变化就提醒我；5分钟后提醒我喝水。',
  ])('allows distinct explicit concurrent commands: %s', (request) => {
    expect(hasExplicitTaskIntent(request, 'monitor')).toBe(true);
    expect(hasExplicitTaskIntent(request, 'timer')).toBe(true);
    expect(hasExplicitTaskIntent(request, 'handoff')).toBe(false);
  });

  it.each([
    '他说Watch the window and set a five-minute timer',
    '他说“Watch the window” and create a new background agent session',
    'Explain the phrase Watch the window and set a five-minute timer',
    'If I asked you to watch the window and set a five-minute timer, what would happen?',
    '如果我让你监控窗户，同时五分钟后提醒我喝水，会怎样？',
    '监控窗户，同时他说五分钟后提醒我喝水',
    '他说监控窗户；5分钟后提醒我喝水。',
    'Explain how to monitor the window; set a five-minute timer.',
  ])('does not promote reported/hypothetical conjunctions: %s', (request) => {
    for (const kind of KINDS)
      expect(hasExplicitTaskIntent(request, kind)).toBe(false);
  });
});

describe('cancellation target scope', () => {
  const ppt = { id: 'job_ppt', title: 'Create a PowerPoint presentation' };
  const download = { id: 'job_download', title: '下载代码' };
  const build = { id: 'job_build', title: 'Build project' };
  const candidates = [ppt, download, build];

  it.each([
    '取消PPT',
    '取消演示文稿任务',
    'Stop the presentation task',
    'Cancel job_ppt',
    '请取消名叫“PPT”的任务',
  ])('accepts a uniquely named target: %s', (request) => {
    expect(cancellationTargetMatches(request, ppt, candidates)).toBe(true);
    expect(cancellationTargetMatches(request, download, candidates)).toBe(
      false,
    );
  });

  it('does not confuse a requested name with a partial word', () => {
    const rebuild = { id: 'rebuild', title: 'Rebuild project' };
    expect(
      cancellationTargetMatches('Stop the build task', rebuild, [rebuild]),
    ).toBe(false);
    expect(
      cancellationTargetMatches('Stop the build task', build, candidates),
    ).toBe(true);
  });

  it.each([
    '取消刚才那个任务',
    '取消当前任务',
    'Stop this task',
    'Cancel the previous task',
  ])(
    'resolves deictic targets only with exactly one candidate: %s',
    (request) => {
      expect(cancellationTargetMatches(request, ppt, [ppt])).toBe(true);
      expect(cancellationTargetMatches(request, ppt, candidates)).toBe(false);
    },
  );

  it.each([
    '停止所有任务',
    '取消全部子智能体',
    'Stop all tasks',
    'Cancel all jobs',
  ])('authorizes all tasks and each selected member: %s', (request) => {
    for (const candidate of candidates) {
      expect(
        cancellationTargetMatches(request, candidate, candidates, true),
      ).toBe(true);
      expect(cancellationTargetMatches(request, candidate, candidates)).toBe(
        true,
      );
    }
  });

  it.each([
    '取消PPT',
    '取消所有监控',
    '停止全部播报',
    '取消除了下载以外全部任务',
    'Cancel all tasks except download',
    'Stop everything',
    '不要取消PPT，停止所有任务',
    'Stop all tasks, keep the download running',
  ])('does not broaden %s to all tasks', (request) => {
    expect(cancellationTargetMatches(request, ppt, candidates, true)).toBe(
      false,
    );
  });

  it.each([
    ['不要取消PPT，取消下载', download, ppt],
    ['取消PPT，不要取消下载', ppt, download],
    ['Do not cancel the presentation, cancel the build task', build, ppt],
  ] as const)(
    'matches only the affirmative cancellation object: %s',
    (request, allowed, denied) => {
      expect(cancellationTargetMatches(request, allowed, candidates)).toBe(
        true,
      );
      expect(cancellationTargetMatches(request, denied, candidates)).toBe(
        false,
      );
    },
  );

  it.each([
    '取消PPT和下载',
    '取消PPT，取消下载',
    'PPT停了吗',
    '他说：取消PPT任务',
    '停止播报PPT进度，PPT继续做',
    '不要取消PPT',
  ])('rejects ambiguity, reports and unrelated speech: %s', (request) => {
    for (const candidate of candidates)
      expect(cancellationTargetMatches(request, candidate, candidates)).toBe(
        false,
      );
  });

  it('requires unique candidate identity and a current exact selected target', () => {
    const secondPpt = { id: 'other_ppt', title: 'Another PPT' };
    expect(
      cancellationTargetMatches('取消PPT', ppt, [...candidates, secondPpt]),
    ).toBe(false);
    expect(cancellationTargetMatches('取消PPT', ppt, [ppt, ppt])).toBe(false);
    expect(
      cancellationTargetMatches(
        'Stop all tasks',
        { ...ppt, title: 'Stale' },
        candidates,
        true,
      ),
    ).toBe(false);
    expect(cancellationTargetMatches('Stop all tasks', ppt, [], true)).toBe(
      false,
    );
  });

  it.each([
    '取消PPT任务，不要取消PPT任务',
    '取消PPT任务，等等，先别取消',
    '取消PPT任务，先别取消',
    'Cancel the presentation task. Do not cancel the presentation task.',
    'Cancel the presentation task. Actually no.',
    '取消PPT并保留下载',
  ])(
    'does not execute a withdrawn or unresolved cancellation: %s',
    (request) => {
      expect(cancellationTargetMatches(request, ppt, candidates)).toBe(false);
      expect(cancellationTargetMatches(request, ppt, candidates, true)).toBe(
        false,
      );
    },
  );

  it('normalizes nested generic task suffixes consistently', () => {
    const task = { id: 'task-test', title: '敲桌子提醒' };
    expect(
      cancellationTargetMatches('取消敲桌子提醒任务。', task, [task]),
    ).toBe(true);
  });
});

describe('update target scope', () => {
  const posture = { id: 'posture', title: 'Watch posture' };
  const timer = { id: 'tea', title: 'Tea timer' };
  const candidates = [posture, timer];

  it.each([
    'Change the posture monitor to remind me once when I lean too close to the screen.',
    'Make the posture monitor repeat whenever I slouch.',
    'Rename the posture monitor to Tea timer.',
    "Change the posture monitor's interval to two seconds.",
  ])('resolves only the existing object: %s', (request) => {
    expect(updateTargetMatches(request, posture, candidates)).toBe(true);
    expect(updateTargetMatches(request, timer, candidates)).toBe(false);
  });

  it('does not select the new name, condition or output text', () => {
    const oldTask = { id: 'old', title: '咳嗽监控' };
    const newTask = { id: 'new', title: '敲桌子监控' };
    const tasks = [oldTask, newTask];
    const request = '把咳嗽监控的名字改为敲桌子监控';
    expect(updateTargetMatches(request, oldTask, tasks)).toBe(true);
    expect(updateTargetMatches(request, newTask, tasks)).toBe(false);
  });

  it.each([
    '把当前任务的间隔改成两秒',
    'Change this task to remind me every minute.',
  ])('requires one candidate for a deictic update: %s', (request) => {
    expect(updateTargetMatches(request, posture, [posture])).toBe(true);
    expect(updateTargetMatches(request, posture, candidates)).toBe(false);
  });

  it.each([
    '不要修改咳嗽监控的间隔，修改敲桌子监控的间隔为两秒',
    'Give me an update on the posture monitor',
    '他说把咳嗽监控的间隔改为两秒',
    'Change the unknown monitor to trigger once.',
    'Change the posture and Tea timer tasks to repeat.',
  ])('rejects negated, reported and unresolved targets: %s', (request) => {
    for (const target of candidates)
      expect(updateTargetMatches(request, target, candidates)).toBe(false);
  });

  it('requires unique and current identity', () => {
    const request = 'Change the posture monitor to trigger once.';
    expect(updateTargetMatches(request, posture, [posture, posture])).toBe(
      false,
    );
    expect(
      updateTargetMatches(request, { ...posture, title: 'Stale' }, candidates),
    ).toBe(false);
    expect(
      updateTargetMatches(request, posture, [
        ...candidates,
        { id: 'other', title: 'Desk posture' },
      ]),
    ).toBe(false);
  });
});
