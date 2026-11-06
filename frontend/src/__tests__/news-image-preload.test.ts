// @vitest-environment jsdom
/**
 * The "What's New" modal opens with its pictures already loaded
 * (lib/newsSource.ts preloadNewsImages, awaited by getNextNews): a picture
 * that arrived after the modal pushed the text down while it was being read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNextNews,
  newsImageUrls,
  preloadNewsImages,
  registerNewsSource,
  type NewsPost,
} from '../lib/newsSource';

const PIC = 'https://velxio.dev/api/pro/news/images/0123456789abcdef.webp';
const PIC2 = 'https://cdn.example.com/a/b.png?v=2';

/** Image stand-in: loads (or fails) when the test says so. */
class FakeImage {
  static all: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  decode = vi.fn(() => Promise.resolve());
  constructor() {
    FakeImage.all.push(this);
  }
}

const realImage = globalThis.Image;
beforeEach(() => {
  FakeImage.all = [];
  (globalThis as { Image: unknown }).Image = FakeImage;
});
afterEach(() => {
  (globalThis as { Image: unknown }).Image = realImage;
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('newsImageUrls', () => {
  it('finds markdown images and bare image links, in order, once each', () => {
    const md = `![](${PIC})\n\nText [a link](https://velxio.dev/editor "button")\n\n![shot](${PIC2} "title")\n\n${PIC}`;
    expect(newsImageUrls(md)).toEqual([PIC, PIC2]);
  });

  it('ignores links that are not pictures', () => {
    expect(newsImageUrls('[docs](https://velxio.dev/docs/worlds/) and https://velxio.dev/example/x')).toEqual([]);
  });
});

describe('preloadNewsImages', () => {
  it('resolves at once for a body without pictures', async () => {
    await preloadNewsImages('No pictures here.');
    expect(FakeImage.all).toHaveLength(0);
  });

  it('waits until every picture is loaded and decoded', async () => {
    let done = false;
    const p = preloadNewsImages(`![](${PIC}) ![](${PIC2})`).then(() => (done = true));
    await flush();
    expect(FakeImage.all.map((i) => i.src)).toEqual([PIC, PIC2]);
    FakeImage.all[0].onload!();
    await flush();
    expect(done).toBe(false);
    FakeImage.all[1].onload!();
    await p;
    expect(done).toBe(true);
    expect(FakeImage.all[1].decode).toHaveBeenCalled();
  });

  it('does not let a broken picture hold the post', async () => {
    const p = preloadNewsImages(`![](${PIC})`);
    await flush();
    FakeImage.all[0].onerror!();
    await expect(p).resolves.toBeUndefined();
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = preloadNewsImages(`![](${PIC})`, 4000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(done).toBe(true);
  });
});

describe('getNextNews', () => {
  it('hands the post over only once its picture has loaded', async () => {
    const post: NewsPost = { id: 'p1', title: 'T', body_md: `![](${PIC})\n\nBody`, publish_date: '2026-11-06' };
    registerNewsSource(async () => post);
    let got: NewsPost | null | undefined;
    const p = getNextNews().then((r) => (got = r));
    for (let i = 0; i < 5 && !FakeImage.all.length; i++) await flush();
    expect(FakeImage.all).toHaveLength(1);
    expect(got).toBeUndefined();
    FakeImage.all[0].onload!();
    await p;
    expect(got).toBe(post);
  });
});
