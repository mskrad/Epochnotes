// Written for the corpus after constants seen in the field: the time until a future slot is estimated at 400 ms
// per slot.
package watcher

import "time"

const estimatedSlotTime = 400 * time.Millisecond

func untilSlot(current, target uint64) time.Duration {
	return time.Duration(target-current) * estimatedSlotTime
}
