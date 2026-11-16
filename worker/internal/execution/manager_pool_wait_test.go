package execution

import (
	"context"
	"testing"

	"oasm-worker/internal/runtime"
)

// Per-image quota waits must not be kept alive by unrelated work; node budget
// waits can be unblocked by any image releasing its resources.
func TestPoolWaitProgressTracksRelevantExecutions(t *testing.T) {
	m := NewManager(runtime.NewFakeRuntime(), 0)
	m.SetPool(NewPoolManager(ConnectorIdleTimeout, 1, 1))
	spec := JobSpec{Image: "ghcr.io/sil3ntcor3/connector-nuclei:3.11.1"}
	id, err := m.Submit(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	other := JobSpec{Image: "ghcr.io/sil3ntcor3/connector-nmap:7.97"}
	for _, tc := range []struct {
		name     string
		spec     JobSpec
		nodeWide bool
		working  bool
	}{
		{"same image", spec, false, true},
		{"other image quota", other, false, false},
		{"other image node budget", other, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if freed, working := m.PoolWaitProgress(tc.spec, tc.nodeWide); freed != 0 || working != tc.working {
				t.Fatalf("progress = (%d, %t), want (0, %t)", freed, working, tc.working)
			}
		})
	}
	if err := m.Release(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if freed, working := m.PoolWaitProgress(spec, false); freed != 1 || working {
		t.Fatalf("released execution progress = (%d, %t), want (1, false)", freed, working)
	}
}

// Creation reservations are work; stale busy containers without an execution
// or reservation must still allow the worker's no-progress deadline to expire.
func TestPoolWaitProgressDistinguishesCreationFromStaleCapacity(t *testing.T) {
	m := NewManager(runtime.NewFakeRuntime(), 0)
	spec := JobSpec{Image: "ghcr.io/sil3ntcor3/connector-nuclei:3.11.1"}
	if freed, working := m.PoolWaitProgress(spec, false); freed != 0 || working {
		t.Fatalf("disabled pool progress = (%d, %t), want (0, false)", freed, working)
	}
	p := NewPoolManager(ConnectorIdleTimeout, 1, 1)
	m.SetPool(p)
	if !p.ReserveReplica("creating", poolKeyFor(spec), 500, 512<<20) {
		t.Fatal("expected creation reservation")
	}
	if _, working := m.PoolWaitProgress(spec, false); !working {
		t.Fatal("pending container creation must keep the queue alive")
	}
	other := JobSpec{Image: "other"}
	if _, working := m.PoolWaitProgress(other, false); working {
		t.Fatal("unrelated creation must not renew an image quota wait")
	}
	if _, working := m.PoolWaitProgress(other, true); !working {
		t.Fatal("pending creation reserves resources for node-wide waits")
	}
	p.ReleaseReplica("creating")
	p.Add(poolEntry{ID: "stale", ExecID: "missing", PoolKey: poolKeyFor(spec), State: PoolStateBusy})
	if freed, working := m.PoolWaitProgress(spec, false); freed != 0 || working {
		t.Fatalf("stale busy capacity progress = (%d, %t), want (0, false)", freed, working)
	}
}

// Other work cannot unblock a request larger than the node's total budget.
func TestPoolWaitProgressDoesNotExtendImpossibleNodeRequest(t *testing.T) {
	m := NewManager(runtime.NewFakeRuntime(), 0)
	p := NewPoolManager(ConnectorIdleTimeout, 1, 1)
	p.SetResourceBudget(1000, 1<<30)
	m.SetPool(p)
	id, err := m.Submit(context.Background(), JobSpec{Image: "running"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Cancel(context.Background(), id) })
	for _, limits := range []map[string]any{
		{JobCPUKey: "2000m", JobMemoryKey: "512Mi"},
		{JobCPUKey: "500m", JobMemoryKey: "2Gi"},
	} {
		if _, working := m.PoolWaitProgress(JobSpec{Image: "waiting", Limits: limits}, true); working {
			t.Fatalf("unrelated work cannot unblock a request exceeding the node budget: %v", limits)
		}
	}
}
