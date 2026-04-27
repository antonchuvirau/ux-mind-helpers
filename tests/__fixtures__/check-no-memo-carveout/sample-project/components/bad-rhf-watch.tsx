import { useForm } from "react-hook-form";

export function Form() {
  const { watch } = useForm();
  const value = watch("name");
  return null;
}
