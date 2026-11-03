package worker

import (
	"testing"
	"time"
)

func TestPollPolicy_FlowFillsAllSlots(t *testing.T) {
	p := newPollPolicy()

	if !p.flowing() {
		t.Fatal("a fresh policy must be flowing so a backlog is drained at full concurrency")
	}
	if got := p.nextDelay(3); got != pollRefillDelay {
		t.Fatalf("flowing nextDelay = %v, want %v (refill freed slots quickly)", got, pollRefillDelay)
	}
}

func TestPollPolicy_EmptyPollsBackOff(t *testing.T) {
	p := newPollPolicy()
	p.feedback(false)

	if p.flowing() {
		t.Fatal("an empty poll must stop the policy from flowing")
	}
	if got := p.nextDelay(1); got != p.backoff || got <= pollIdleBackoff {
		t.Fatalf("idle nextDelay = %v, want the grown backoff %v", got, p.backoff)
	}

	for range 10 {
		p.feedback(false)
	}
	if p.backoff != pollMaxBackoff {
		t.Fatalf("backoff must cap at %v, got %v", pollMaxBackoff, p.backoff)
	}
}

func TestPollPolicy_JobResetsBackoff(t *testing.T) {
	p := newPollPolicy()
	p.feedback(false)
	p.feedback(false)
	if p.backoff == pollIdleBackoff {
		t.Fatal("precondition: backoff should have grown")
	}

	p.feedback(true)
	if p.backoff != pollIdleBackoff {
		t.Fatalf("finding a job must reset backoff to %v, got %v", pollIdleBackoff, p.backoff)
	}
	if !p.flowing() {
		t.Fatal("finding a job must resume flowing")
	}
}

// Empty or failed claims have free capacity; they must not use the busy-slot retry.
func TestPollPolicy_EmptyClaimsBackOff(t *testing.T) {
	p := newPollPolicy()
	for i, want := range []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second} {
		if got := p.nextDelay(0); got != want {
			t.Fatalf("empty claim %d delay = %v, want %v", i+1, got, want)
		}
		if p.flowing() {
			t.Fatal("an empty claim must leave flowing mode")
		}
	}
	p.feedback(true)
	if got := p.nextDelay(1); got != pollRefillDelay {
		t.Fatalf("job after idle delay = %v, want refill %v", got, pollRefillDelay)
	}
}
