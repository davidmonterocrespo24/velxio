import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CompileContext } from '@velxio/sdk';
import {
  CompileMiddlewareChain,
  getCompileMiddlewareChain,
  __resetCompileMiddlewareForTests,
} from '../simulation/CompileMiddleware';

const ctx = (board = 'arduino:avr:uno'): CompileContext => ({
  runId: 'r1',
  board,
  startedAt: 0,
  notes: [],
});

const file = (name: string, content: string) => ({ name, content });

describe('CompileMiddlewareChain — pre registration and order', () => {
  let chain: CompileMiddlewareChain;
  beforeEach(() => {
    chain = new CompileMiddlewareChain();
  });

  it('returns the input unchanged when no middlewares are registered', async () => {
    const files = [file('sketch.ino', 'void setup(){}')];
    const out = await chain.runPre(files, ctx());
    expect(out).toEqual(files);
  });

  it('runs pre middlewares in registration order', async () => {
    chain.pre('client', (files) =>
      files.map((f) => ({ ...f, content: f.content + '/*A*/' })),
    );
    chain.pre('client', (files) =>
      files.map((f) => ({ ...f, content: f.content + '/*B*/' })),
    );
    const out = await chain.runPre([file('s.ino', 'x')], ctx());
    expect(out[0].content).toBe('x/*A*//*B*/');
  });

  it('supports async pre middlewares', async () => {
    chain.pre('client', async (files) => {
      await new Promise((r) => setTimeout(r, 5));
      return files.map((f) => ({ ...f, content: f.content.toUpperCase() }));
    });
    const out = await chain.runPre([file('s.ino', 'abc')], ctx());
    expect(out[0].content).toBe('ABC');
  });

  it('dispose() removes a middleware before it runs', async () => {
    const handle = chain.pre('client', (files) =>
      files.map((f) => ({ ...f, content: 'MODIFIED' })),
    );
    handle.dispose();
    const out = await chain.runPre([file('s.ino', 'orig')], ctx());
    expect(out[0].content).toBe('orig');
  });
});

describe('CompileMiddlewareChain — pre error handling', () => {
  it('throws when a pre middleware throws, aborting the chain', async () => {
    const chain = new CompileMiddlewareChain();
    chain.pre('client', () => {
      throw new Error('pre-error');
    });
    const downstream = vi.fn();
    chain.pre('client', (files) => {
      downstream();
      return files;
    });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(chain.runPre([file('s.ino', 'x')], ctx())).rejects.toThrow(
      'pre-error',
    );
    expect(downstream).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('throws when a pre middleware returns an empty array', async () => {
    const chain = new CompileMiddlewareChain();
    chain.pre('client', () => [] as never);
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(chain.runPre([file('s.ino', 'x')], ctx())).rejects.toThrow(
      /returned no files/,
    );
    consoleErr.mockRestore();
  });

  it('aborts with a timeout error if pre middleware takes >5s', async () => {
    const chain = new CompileMiddlewareChain();
    chain.pre(
      'client',
      () => new Promise(() => {}) as unknown as ReturnType<typeof Promise.resolve>,
    );
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = chain.runPre([file('s.ino', 'x')], ctx());
    await vi.waitFor(
      async () => {
        await expect(p).rejects.toThrow(/timed out after 5000ms/);
      },
      { timeout: 7000 },
    );
    consoleErr.mockRestore();
  }, 10_000);
});

describe('CompileMiddlewareChain — post ordering and isolation', () => {
  it('runs post middlewares in reverse registration (LIFO) order', async () => {
    const chain = new CompileMiddlewareChain();
    const order: string[] = [];
    chain.post('client', () => {
      order.push('first-registered');
    });
    chain.post('client', () => {
      order.push('second-registered');
    });
    await chain.runPost(
      { ok: true, durationMs: 10, hex: 'hex', stderr: '', stdout: '' },
      ctx(),
    );
    expect(order).toEqual(['second-registered', 'first-registered']);
  });

  it('swallows exceptions from post middleware and keeps running others', async () => {
    const chain = new CompileMiddlewareChain();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const next = vi.fn();
    chain.post('client', () => {
      throw new Error('boom');
    });
    chain.post('client', next);
    await chain.runPost(
      { ok: true, durationMs: 10, hex: 'x', stderr: '', stdout: '' },
      ctx(),
    );
    expect(next).toHaveBeenCalled();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('receives the compile result payload', async () => {
    const chain = new CompileMiddlewareChain();
    const observed: Array<unknown> = [];
    chain.post('client', (result) => {
      observed.push(result);
    });
    const result = {
      ok: true,
      durationMs: 123,
      hex: ':00000001FF',
      stderr: '',
      stdout: 'done',
    };
    await chain.runPost(result, ctx('arduino:avr:uno'));
    expect(observed[0]).toEqual(result);
  });

  it('does not throw when a post middleware times out', async () => {
    const chain = new CompileMiddlewareChain();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    chain.post(
      'client',
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    // Should resolve (not reject) after the 5s timeout is logged.
    await expect(
      chain.runPost(
        { ok: true, durationMs: 10, hex: 'x', stderr: '', stdout: '' },
        ctx(),
      ),
    ).resolves.toBeUndefined();
    consoleErr.mockRestore();
  }, 10_000);
});

describe('CompileMiddlewareChain — counts and clearing', () => {
  it('preCount/postCount reflect adds and dispose', () => {
    const chain = new CompileMiddlewareChain();
    expect(chain.preCount()).toBe(0);
    const a = chain.pre('client', (f) => f);
    const b = chain.pre('client', (f) => f);
    const c = chain.post('client', () => {});
    expect(chain.preCount()).toBe(2);
    expect(chain.postCount()).toBe(1);
    a.dispose();
    c.dispose();
    expect(chain.preCount()).toBe(1);
    expect(chain.postCount()).toBe(0);
    b.dispose();
    expect(chain.preCount()).toBe(0);
  });

  it('__clearForTests resets all hooks', () => {
    const chain = new CompileMiddlewareChain();
    chain.pre('client', (f) => f);
    chain.post('client', () => {});
    chain.__clearForTests();
    expect(chain.preCount()).toBe(0);
    expect(chain.postCount()).toBe(0);
  });
});

describe('getCompileMiddlewareChain singleton', () => {
  beforeEach(() => {
    __resetCompileMiddlewareForTests();
  });

  it('returns the same chain instance across calls', () => {
    expect(getCompileMiddlewareChain()).toBe(getCompileMiddlewareChain());
  });

  it('creates a fresh chain after reset', () => {
    const a = getCompileMiddlewareChain();
    __resetCompileMiddlewareForTests();
    const b = getCompileMiddlewareChain();
    expect(a).not.toBe(b);
  });
});
