// Written for the corpus: the slot time is measured from recent performance samples of the cluster.
package watcher

import "time"

func untilSlot(current, target uint64, sampledSlots, sampledSeconds uint64) time.Duration {
	return time.Duration(target-current) * time.Duration(sampledSeconds) * time.Second / time.Duration(sampledSlots)
}
