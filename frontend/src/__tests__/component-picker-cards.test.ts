// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ONLINE_EDITOR_URL } from '../lib/onlineOnlyBoards';
import type { ComponentMetadata } from '../types/component-metadata';

const part: ComponentMetadata = {
  id: 'picker-test-part',
  tagName: 'picker-test-part',
  name: 'Test picker part',
  category: 'input',
  description: 'A part with its own thumbnail and badge',
  thumbnail: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
  properties: [],
  defaultValues: {},
  pinCount: 2,
  tags: [],
  custom: true,
};

it('preserves the picker thumbnails, hover panel, and click targets for all four card types', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/components-metadata.json'
        ? new Response(JSON.stringify({ components: [part] }))
        : new Response(null, { status: 404 }),
    ),
  );
  // Keep unrelated live web components outside the visible region in jsdom.
  const observedCards: Element[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(card: Element) {
        observedCards.push(card);
      }
      disconnect() {}
    },
  );
  vi.useFakeTimers();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const root = createRoot(document.createElement('div'));
  const onSelectComponent = vi.fn();
  const onSelectBoard = vi.fn();
  const onClose = vi.fn();

  try {
    // The registry starts loading as soon as the picker module is imported.
    const { ComponentPickerModal } = await import('../components/ComponentPickerModal');
    const { HOVER_DELAY } = await import('../components/ComponentInfoPanel');
    await act(async () => {
      root.render(
        createElement(ComponentPickerModal, { isOpen: true, onClose, onSelectComponent, onSelectBoard }),
      );
    });

    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('button.component-card'));
    const component = cards.find((card) => card.querySelector('.card-name')?.textContent === part.name)!;
    const board = cards.find((card) => card.querySelector('.card-name')?.textContent === 'Arduino Uno')!;
    const onlineBoard = cards.find((card) => card.title.includes(': free to use in the online editor'))!;
    const onlinePart = cards.find((card) => card.title.includes(': available in the online editor'))!;
    expect(component.querySelector('.card-thumbnail svg')).not.toBeNull();
    expect(component.querySelector('.card-pins')?.textContent).toBe('2 pins');
    expect(component.textContent).toContain('CUSTOM');
    expect(board.querySelector('.card-thumbnail .component-preview')).not.toBeNull();
    expect(observedCards).toContain(board);
    expect(onlineBoard.querySelector('.card-thumbnail svg')).not.toBeNull();
    expect(onlinePart.querySelector('.card-thumbnail svg')).not.toBeNull();

    act(() => component.focus());
    act(() => vi.advanceTimersByTime(HOVER_DELAY));
    expect(document.querySelector('.component-info-panel')?.textContent).toContain(part.name);

    act(() => onlineBoard.click());
    act(() => onlinePart.click());
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(ONLINE_EDITOR_URL, '_blank', 'noopener');
    expect(onClose).not.toHaveBeenCalled();

    act(() => component.click());
    expect(onSelectComponent).toHaveBeenCalledWith(expect.objectContaining({ id: part.id }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => board.click());
    expect(onSelectBoard).toHaveBeenCalledWith('arduino-uno');
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    open.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
