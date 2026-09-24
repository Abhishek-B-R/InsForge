import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type FlagCallback = (
  flags: string[],
  variants: Record<string, string | boolean>,
  context?: { errorsLoading?: boolean }
) => void;

const mocks = vi.hoisted(() => {
  let flagCallback: FlagCallback | null = null;
  let currentFlags: Record<string, string | boolean> = {};
  let hasLoadedFlags = false;

  const fire = (errorsLoading?: boolean) =>
    flagCallback?.(Object.keys(currentFlags), currentFlags, { errorsLoading });

  return {
    reset() {
      flagCallback = null;
      currentFlags = {};
      hasLoadedFlags = false;
    },
    setFlags(flags: Record<string, string | boolean>) {
      currentFlags = flags;
      hasLoadedFlags = true;
    },
    fireFlags() {
      fire();
    },
    // posthog-js calls back with errorsLoading when it abandons the request: a timeout, a
    // connection error or a non-200. A quota-limited response is the one that never calls back.
    fireFlagsError() {
      fire(true);
    },
    hasSubscriber() {
      return flagCallback !== null;
    },
    posthog: {
      init: vi.fn(),
      config: { feature_flag_request_timeout_ms: 3000 },
      getFeatureFlag: vi.fn((key: string) => currentFlags[key]),
      onFeatureFlags: vi.fn((cb: FlagCallback) => {
        flagCallback = cb;
        // Like posthog-js, call back straight away when flags are already loaded.
        if (hasLoadedFlags) {
          cb(Object.keys(currentFlags), currentFlags, {});
        }
        return () => {
          if (flagCallback === cb) {
            flagCallback = null;
          }
        };
      }),
      featureFlags: {
        get hasLoadedFlags() {
          return hasLoadedFlags;
        },
      },
    },
  };
});

vi.mock('posthog-js', () => ({
  default: mocks.posthog,
}));

vi.mock('posthog-js/react', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('feature flag hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    vi.stubEnv('VITE_PUBLIC_POSTHOG_KEY', 'phc_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('useFeatureFlag updates when PostHog fires onFeatureFlags', async () => {
    mocks.setFlags({});
    const { useFeatureFlag } = await import('#lib/analytics/posthog');
    const { result } = renderHook(() => useFeatureFlag('dashboard-v4-experiment'));

    expect(result.current).toBeUndefined();

    act(() => {
      mocks.setFlags({ 'dashboard-v4-experiment': 'd_test' });
      mocks.fireFlags();
    });

    expect(result.current).toBe('d_test');
  });

  it("useFeatureFlag never returns the previous key's value after the key changes", async () => {
    mocks.setFlags({ first: 'a', second: 'b' });
    const { useFeatureFlag } = await import('#lib/analytics/posthog');
    const seen: Array<[string, string | boolean | undefined]> = [];
    const { rerender } = renderHook(
      ({ flag }) => {
        seen.push([flag, useFeatureFlag(flag)]);
      },
      { initialProps: { flag: 'first' } }
    );

    rerender({ flag: 'second' });

    expect(seen.filter(([flag]) => flag === 'second').map(([, value]) => value)).not.toContain('a');
    expect(seen[seen.length - 1]).toEqual(['second', 'b']);
  });

  it('useFeatureFlag unsubscribes on unmount', async () => {
    const { useFeatureFlag } = await import('#lib/analytics/posthog');
    const { unmount } = renderHook(() => useFeatureFlag('dashboard-v4-experiment'));

    expect(mocks.hasSubscriber()).toBe(true);
    unmount();
    expect(mocks.hasSubscriber()).toBe(false);
  });

  it('useFeatureFlagsReady flips true after the first flag load', async () => {
    const { useFeatureFlagsReady } = await import('#lib/analytics/posthog');
    const { result } = renderHook(() => useFeatureFlagsReady());

    expect(result.current).toBe(false);

    act(() => {
      mocks.setFlags({ 'dashboard-v4-experiment': 'control' });
      mocks.fireFlags();
    });

    expect(result.current).toBe(true);
  });

  it('useFeatureFlagsReady starts true when flags were already loaded', async () => {
    mocks.setFlags({ 'dashboard-v4-experiment': 'control' });
    const { useFeatureFlagsReady } = await import('#lib/analytics/posthog');
    const { result } = renderHook(() => useFeatureFlagsReady());

    expect(result.current).toBe(true);
  });

  // A quota-limited flags response never reaches onFeatureFlags, so readiness has to time out,
  // but not before PostHog itself would have given up on a slow request.
  it('useFeatureFlagsReady stops waiting only after the PostHog request timeout', async () => {
    const { useFeatureFlagsReady } = await import('#lib/analytics/posthog');
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useFeatureFlagsReady());

      // The mocked 3s request timeout plus the 2s margin.
      act(() => {
        vi.advanceTimersByTime(4999);
      });
      expect(result.current).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The elapsed wait is the end of waiting, not an answer. Reporting it as `loaded` made every
  // flag read as undefined, which is what a control user reads, so one-shot decisions took the
  // control branch for a D_TEST user whose response was still in flight.
  it('useFeatureFlagsStatus reports an elapsed wait as unavailable, not loaded', async () => {
    const { useFeatureFlagsStatus } = await import('#lib/analytics/posthog');
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useFeatureFlagsStatus());

      expect(result.current).toBe('pending');

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('useFeatureFlagsStatus upgrades to loaded when a late answer arrives', async () => {
    const { useFeatureFlagsStatus } = await import('#lib/analytics/posthog');
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useFeatureFlagsStatus());

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current).toBe('unavailable');

      // Still subscribed, so the answer that was in flight is not thrown away.
      expect(mocks.hasSubscriber()).toBe(true);
      act(() => {
        mocks.setFlags({ 'dashboard-v4-experiment': 'd_test' });
        mocks.fireFlags();
      });
      expect(result.current).toBe('loaded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('useFeatureFlagsStatus reports a failed request as unavailable', async () => {
    const { useFeatureFlagsStatus } = await import('#lib/analytics/posthog');
    const { result } = renderHook(() => useFeatureFlagsStatus());

    expect(result.current).toBe('pending');

    act(() => {
      mocks.fireFlagsError();
    });

    expect(result.current).toBe('unavailable');
  });

  it('useFeatureFlagsStatus is loaded straight away with no PostHog key', async () => {
    vi.stubEnv('VITE_PUBLIC_POSTHOG_KEY', '');
    vi.resetModules();
    const { useFeatureFlagsStatus } = await import('#lib/analytics/posthog');
    const { result } = renderHook(() => useFeatureFlagsStatus());

    expect(result.current).toBe('loaded');
  });
});
