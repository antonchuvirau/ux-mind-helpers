import { useFormState } from "react-hook-form";

export function FieldError() {
  const formState = useFormState({ name: "field" });
  return null;
}
