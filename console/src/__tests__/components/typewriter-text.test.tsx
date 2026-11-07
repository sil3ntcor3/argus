import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TypewriterText from '@/components/typewriter-text';

function typeCharacter() {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

describe('TypewriterText', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts over when a shorter prompt list replaces an active list', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { rerender } = render(<TypewriterText texts={['a', 'b', 'c', 'd']} />);
    typeCharacter();
    expect(screen.getByText('d')).toBeInTheDocument();

    rerender(<TypewriterText texts={['xy', 'zw']} />);
    typeCharacter();
    typeCharacter();
    expect(screen.getByText('zw')).toBeInTheDocument();
    expect(screen.queryByText('d')).not.toBeInTheDocument();
  });

  it('handles an empty prompt list and resumes when prompts arrive', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TypewriterText texts={[]} />);
    typeCharacter();

    rerender(<TypewriterText texts={['a']} />);
    typeCharacter();
    expect(screen.getByText('a')).toBeInTheDocument();

    rerender(<TypewriterText texts={[]} />);
    typeCharacter();
    expect(screen.queryByText('a')).not.toBeInTheDocument();
  });
});
