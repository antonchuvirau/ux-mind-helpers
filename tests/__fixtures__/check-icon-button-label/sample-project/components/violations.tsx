// Each <Button>/<InputGroupButton> below should be flagged.

import { XIcon, SearchIcon, CheckIcon } from "lucide-react";

import { Button } from "~/ui/button";
import { InputGroupButton } from "~/ui/input-group";

export function ViolationSelfClosingIconChild() {
  return (
    <Button>
      <XIcon />
    </Button>
  );
}

export function ViolationPairedIconChild() {
  return (
    <Button variant="ghost">
      <SearchIcon></SearchIcon>
    </Button>
  );
}

export function ViolationWithComment() {
  return (
    <Button>
      {/* close */}
      <XIcon />
    </Button>
  );
}

export function ViolationInputGroupButton() {
  return (
    <InputGroupButton>
      <CheckIcon />
    </InputGroupButton>
  );
}

export function ViolationPropsButNoLabel() {
  return (
    <Button onClick={() => {}} variant="outline" size="sm">
      <XIcon />
    </Button>
  );
}
