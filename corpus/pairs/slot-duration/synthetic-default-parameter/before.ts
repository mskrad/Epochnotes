// Written for the corpus after an example seen in the field: the slot time is a default parameter of 400, and the
// conversion multiplies by the parameter.
export function formatAge(slot: number, currentSlot: number, slotTime: number = 400): string {
  const ageSeconds = ((currentSlot - slot) * slotTime) / 1000;
  return `${ageSeconds.toFixed(1)}s ago`;
}
