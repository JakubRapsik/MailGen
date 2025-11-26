import { useEffect, useState, useRef, useCallback } from 'react';

type Orders = any[];

class OrdersPoller {
  subscribers = new Set<(o: Orders) => void>();
  lastPayloadHash: string | null = null;
  baseInterval = 15000; // 15s default (tuned down frequency)
  interval = this.baseInterval;
  maxInterval = 120000; // 120s max backoff
  timer: number | null = null;
  running = false;
  inFlight = false; // avoid concurrent fetches
  pendingForce = false; // coalesce multiple forcePoll requests
  lastForceAt = 0; // throttle manual forcePoll calls
  forceThrottleMs = 3000; // at most one forced poll per 3s
  pollCount = 0; // debug counter

  subscribe(fn: (o: Orders) => void) {
    this.subscribers.add(fn);
    if (!this.running && typeof document !== 'undefined' && !document.hidden) {
      this.start();
    }
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  notify(orders: Orders) {
    this.subscribers.forEach((s) => {
      try { s(orders); } catch (e) { /* ignore subscriber errors */ }
    });
  }

  async fetchOnce() {
    if (this.inFlight) {
      // if a fetch is already running, skip this call to avoid duplicates
      console.warn('[OrdersPoller] fetchOnce skipped - already in flight');
      return null;
    }
    this.inFlight = true;
    try {
      this.pollCount++;
      console.debug(`[OrdersPoller] fetchOnce #${this.pollCount} interval=${this.interval}`);
      const res = await fetch(`/api/stored-orders?_ts=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) return null;
      const json = await res.json();
      return Array.isArray(json) ? json : null;
    } catch (e) {
      console.warn('[OrdersPoller] fetchOnce error', e);
      return null;
    } finally {
      this.inFlight = false;
      // if a force was requested while inFlight, schedule another immediate poll
      if (this.pendingForce) {
        this.pendingForce = false;
        // schedule immediate poll but avoid recursion
        setTimeout(() => this.pollCycle(), 50);
      }
    }
  }

  async pollCycle() {
    if (typeof document !== 'undefined' && document.hidden) {
      this.stopTimer();
      return;
    }

    const payload = await this.fetchOnce();
    if (payload) {
      const hash = JSON.stringify(payload);
      if (hash !== this.lastPayloadHash) {
        this.lastPayloadHash = hash;
        this.interval = this.baseInterval; // reset backoff when changed
        this.notify(payload);
      } else {
        // no change -> backoff
        this.interval = Math.min(this.interval * 2, this.maxInterval);
      }
    } else {
      // on error or null payload, backoff moderately
      this.interval = Math.min(this.interval * 2, this.maxInterval);
    }

    this.startTimer();
  }

  startTimer() {
    this.stopTimer();
    this.timer = window.setTimeout(() => this.pollCycle(), this.interval);
  }

  stopTimer() {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.interval = this.baseInterval;
    // run immediate cycle
    this.pollCycle();
  }

  stop() {
    this.running = false;
    this.stopTimer();
  }

  async forcePoll() {
    const now = Date.now();
    if (now - this.lastForceAt < this.forceThrottleMs) {
      // throttle frequent manual forces; coalesce into pendingForce
      this.pendingForce = true;
      return;
    }
    this.lastForceAt = now;

    // If a fetch is in flight, mark pending and return — fetchOnce will trigger another when done
    if (this.inFlight) {
      this.pendingForce = true;
      return;
    }

    const payload = await this.fetchOnce();
    if (payload) {
      const hash = JSON.stringify(payload);
      if (hash !== this.lastPayloadHash) {
        this.lastPayloadHash = hash;
        this.interval = this.baseInterval;
        this.notify(payload);
      }
    }
  }
}

// attach singleton to window to avoid multiple instances across modules
declare global {
  interface Window { __ordersPoller?: OrdersPoller }
}

if (typeof window !== 'undefined' && !window.__ordersPoller) {
  window.__ordersPoller = new OrdersPoller();
  // pause/resume on visibility change
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.__ordersPoller?.stop();
    } else if (window.__ordersPoller?.subscribers.size) {
      window.__ordersPoller?.start();
    }
  });
}

export function useOrdersPolling(initial: Orders = []) {
  const [orders, setOrders] = useState<Orders>(initial);
  const unsubRef = useRef<() => void | null>(null);

  useEffect(() => {
    const poller = typeof window !== 'undefined' ? window.__ordersPoller! : null;
    if (!poller) return;

    const unsubscribe = poller.subscribe((o) => setOrders(o));
    unsubRef.current = unsubscribe;

    // immediate fetch on mount
    poller.forcePoll().catch(() => {});

    return () => {
      unsubscribe();
      unsubRef.current = null;
    };
  }, []);

  const refresh = useCallback(() => {
    const poller = typeof window !== 'undefined' ? window.__ordersPoller! : null;
    if (!poller) return;
    poller.forcePoll().catch(() => {});
  }, []);

  return { orders, refresh };
}
