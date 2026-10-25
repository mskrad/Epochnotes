// Written for the corpus after code seen in the field (Ethereum and Substrate clients, interface components):
// slots of other chains, the word slot in markup, and the numbers 400, 0.4 and 2.5 away from any slot. None of
// this is a Solana slot duration.
const SECONDS_PER_SLOT = 12;
const SLOTS_PER_EPOCH = 32;
const SLOT_DURATION = 6000;
const epochSeconds = SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
const beaconSlot = Math.floor((Date.now() / 1000 - GENESIS_TIME) / SECONDS_PER_SLOT);
const auraTimestamp = SLOT_DURATION * blockNumber;
const slotsPerHour = 300;
const className = 'gap-2 has-data-[slot=attachment-content]:px-2.5';
const dimmed = { opacity: 0.4 };
const share = amount * 0.4;
if (response.status === 400) throw new Error('bad request');
