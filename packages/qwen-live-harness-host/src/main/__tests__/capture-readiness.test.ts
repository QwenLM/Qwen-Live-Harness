import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CaptureReadinessDeadline } from '../capture-readiness.ts';

function fixture() {
  const ready: number[] = [];
  const failed: number[] = [];
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const deadline = new CaptureReadinessDeadline(
    (epoch) => ready.push(epoch),
    (epoch) => failed.push(epoch),
    (callback) => {
      const timer = { run: callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  );
  return { deadline, ready, failed, timers };
}

describe('microphone capture readiness deadline', () => {
  it('requires both the device ACK and a frame, in either order', () => {
    for (const order of ['ack-first', 'frame-first']) {
      const f = fixture();
      f.deadline.arm(7, false);
      if (order === 'ack-first') f.deadline.acknowledge(7);
      else f.deadline.frame(7);
      assert.deepEqual(f.ready, []);
      if (order === 'ack-first') f.deadline.frame(7);
      else f.deadline.acknowledge(7);
      assert.deepEqual(f.ready, [7]);
      assert.equal(f.timers[0]?.cancelled, true);
      f.timers[0]!.run();
      assert.deepEqual(f.failed, []);
    }
  });

  it('times out a silent device without extending its deadline on status refreshes', () => {
    const f = fixture();
    f.deadline.arm(7, false);
    f.deadline.acknowledge(7);
    for (let i = 0; i < 20; i++) f.deadline.arm(7, false);
    assert.equal(f.timers.length, 1);
    f.timers[0]!.run();
    f.timers[0]!.run();
    assert.deepEqual(f.failed, [7]);
    assert.deepEqual(f.ready, []);
    assert.equal(f.deadline.isReady(7), false);
  });

  it('accepts a muted capture without frames and starts a new deadline on unmute', () => {
    const f = fixture();
    f.deadline.arm(7, true);
    f.deadline.acknowledge(7);
    assert.deepEqual(f.ready, [7]);
    f.deadline.arm(7, false);
    assert.equal(f.deadline.isReady(7), false);
    assert.equal(f.timers.length, 2);
    f.deadline.acknowledge(7);
    f.timers[1]!.run();
    assert.deepEqual(f.failed, [7]);
  });

  it('ignores late callbacks after Stop or a replaced epoch', () => {
    const f = fixture();
    f.deadline.arm(7, false);
    f.deadline.arm(8, false);
    f.deadline.acknowledge(7);
    f.deadline.frame(7);
    f.timers[0]!.run();
    f.deadline.cancel();
    f.timers[1]!.run();
    f.deadline.acknowledge(8);
    f.deadline.frame(8);
    assert.deepEqual(f.ready, []);
    assert.deepEqual(f.failed, []);
  });
});
