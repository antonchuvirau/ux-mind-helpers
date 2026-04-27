import { useState } from "react";

export function useCounter() {
  const [n, set] = useState(0);
  return [n, set] as const;
}
