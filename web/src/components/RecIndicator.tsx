// 131-9: The REC indicator. It shows a flat red dot and the word REC, as the
// viewfinder of a VHS camcorder showed them. The dot blinks hard, half a cycle
// on and half off. The word stays on. The sidebar shows it in front of a voice
// room that has people in it. The header shows it beside the version badge
// while you are in a voice room.

interface Props {
  title?: string;
  testID?: string;
}

export function RecIndicator({ title, testID }: Props) {
  return (
    <span class="chalk-rec" title={title} data-testid={testID} role="img" aria-label="recording">
      <span class="chalk-rec-dot" aria-hidden="true" />
      <span class="chalk-rec-text" aria-hidden="true">
        REC
      </span>
    </span>
  );
}
