import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { isAudioOperationCancelled } from '../../preload/audio-errors.ts';

function fixture(finish: () => Promise<void>) {
  const source = readFileSync(
    new URL('../../preload/index.ts', import.meta.url),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const registration = tree.statements.find((statement) => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      return false;
    const call = statement.expression;
    return (
      call.expression.getText(tree) === 'ipcRenderer.on' &&
      call.arguments[0]?.getText(tree) === "'live:audio:output-finished'"
    );
  });
  assert(registration, 'The real output-finished IPC handler must exist');
  const messages: Array<{ channel: string; value: unknown }> = [];
  const identities: object[] = [];
  const stateChanges: string[] = [];
  let listener: ((_event: unknown, identity: object) => void) | undefined;
  runInNewContext(
    ts.transpileModule(registration.getText(tree), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      Error,
      isAudioOperationCancelled,
      audio: {
        finishOutputAudio: (identity: object) => {
          identities.push(identity);
          return finish();
        },
        clearOutput: () => stateChanges.push('clearOutput'),
        recheck: () => stateChanges.push('recheck'),
        dispose: () => stateChanges.push('dispose'),
        setCapture: () => stateChanges.push('setCapture'),
      },
      ipcRenderer: {
        on: (_channel: string, handler: typeof listener) => {
          listener = handler;
        },
        send: (channel: string, value: unknown) => {
          messages.push({ channel, value: JSON.parse(JSON.stringify(value)) });
        },
      },
    },
  );
  return {
    identities,
    messages,
    stateChanges,
    deliver: async () => {
      assert(listener);
      listener({}, { epoch: 7, outputId: 9 });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

describe('output finish failure diagnostics', () => {
  it('handles rejected output completion with local safe diagnostics only', async () => {
    const value = fixture(async () => {
      throw new DOMException(
        'private device path and API key',
        'InvalidStateError',
      );
    });
    await value.deliver();
    assert.deepEqual(value.identities, [{ epoch: 7, outputId: 9 }]);
    assert.deepEqual(value.messages, [
      {
        channel: 'live:audio:diagnostic',
        value: {
          event: 'audio_output_finish_failed',
          details: {
            epoch: 7,
            outputId: 9,
            code: 'audio_output_finish_failed',
            errorName: 'InvalidStateError',
          },
        },
      },
    ]);
    assert.deepEqual(value.stateChanges, []);
  });

  it('never forwards arbitrary error names or messages', async () => {
    const value = fixture(async () => {
      throw Object.assign(new Error('private message'), {
        name: 'secret-device-id',
      });
    });
    await value.deliver();
    const text = JSON.stringify(value.messages);
    assert(text.includes('"errorName":"Error"'));
    assert(!text.includes('private message'));
    assert(!text.includes('secret-device-id'));
    assert.deepEqual(value.stateChanges, []);
  });

  it('does not report successful or deliberately cancelled completion', async () => {
    for (const finish of [
      async () => {},
      async () => {
        throw new DOMException('cancelled', 'AbortError');
      },
    ]) {
      const value = fixture(finish);
      await value.deliver();
      assert.deepEqual(value.messages, []);
      assert.deepEqual(value.stateChanges, []);
    }
  });
});
