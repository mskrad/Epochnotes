// Written for the corpus: the SDK constant, which keeps describing 400 ms slots, turns an age in slots into
// seconds.
use solana_sdk::clock::DEFAULT_MS_PER_SLOT;

pub fn age_in_seconds(current_slot: u64, observed_slot: u64) -> u64 {
    current_slot.saturating_sub(observed_slot) * DEFAULT_MS_PER_SLOT / 1000
}
