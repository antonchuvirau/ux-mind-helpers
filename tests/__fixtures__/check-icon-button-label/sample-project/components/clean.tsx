// None of these should be flagged.

import { XIcon, SearchIcon } from "lucide-react";

import { Button } from "~/ui/button";

export function CleanAriaLabel() {
  return (
    <Button aria-label="Close">
      <XIcon />
    </Button>
  );
}

export function CleanAriaLabelledby() {
  return (
    <Button aria-labelledby="close-label">
      <XIcon />
    </Button>
  );
}

export function CleanTitle() {
  return (
    <Button title="Close">
      <XIcon />
    </Button>
  );
}

export function CleanTextChild() {
  return <Button>Save</Button>;
}

export function CleanIconPlusText() {
  return (
    <Button>
      <SearchIcon />
      Search
    </Button>
  );
}

export function CleanSpreadProps(props: { onClose: () => void }) {
  // Spread is assumed to forward a label dynamically.
  return (
    <Button {...props}>
      <XIcon />
    </Button>
  );
}

export function CleanSelfClosingRenderSlot() {
  // Self-closing <Button … /> — children come from a parent render slot.
  // Out of scope; not flagged.
  return <Button variant="ghost" />;
}

export function CleanWrappedIcon() {
  // Icon isn't a direct only-child; not flagged. Also won't trigger the
  // polymorphic-donut auto-detection — visual mismatch is the user's
  // signal, not this lint.
  return (
    <Button>
      <span>
        <XIcon />
      </span>
    </Button>
  );
}

export function CleanNonIconChild() {
  // Project-internal component that doesn't match the icon-name pattern.
  return <Button>{<CustomLogo />}</Button>;
}

function CustomLogo() {
  return null;
}
