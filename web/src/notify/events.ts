// chalk-web -- which non-message frames become notification events?
//
// The message path has classify.ts; this is the same idea for the event
// frames (voice, friends, channels, governance). Pure and structurally
// typed for the same reason: each of these has exactly one subtle rule
// (only a call *starting*, only a request *received*, never your own
// proposal) that is easy to get wrong and cheap to pin in a test.

// A call "starts" when someone else joins an empty room. Later joiners
// stay silent on purpose: one call would otherwise produce a stroke per
// participant, and whoever is already in the room hears arrivals through
// the call itself. Joins by your own other devices are yours, not news.
//
// The caller passes the roster as it stood BEFORE this join was applied.
export function voiceCallStarted(input: {
  joinerUserID: string;
  meID: string;
  priorRosterSize: number;
}): boolean {
  if (input.joinerUserID === input.meID) return false;
  return input.priorRosterSize === 0;
}

// Only the received request is an event for the bus. Accept/decline
// answer something you did, and "removed" is deliberately quiet -- being
// told with a sound that someone dropped you helps nobody.
export function friendEventNotifies(kind: string): boolean {
  return kind === "request_received";
}

// Only "added" is about you. member_added and the rest fire for existing
// members when the channel changes around them.
export function channelEventNotifies(kind: string): boolean {
  return kind === "added";
}

// Proposals notify when they open and when they resolve, except your
// own -- you know what you proposed, and the resolution reaches you as
// the votes come in. mode_changed and proposal_updated stay silent:
// vote-count churn would rattle all through a ballot.
export function governanceEventNotifies(input: {
  kind: string;
  createdBy?: string;
  meID: string;
}): boolean {
  if (input.kind !== "proposal_opened" && input.kind !== "proposal_resolved") return false;
  return input.createdBy !== input.meID;
}
