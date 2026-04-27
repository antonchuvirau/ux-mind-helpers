"use client";
"use no memo";

import { useReactTable, getCoreRowModel } from "@tanstack/react-table";

export function Table() {
  const table = useReactTable({ data: [], columns: [], getCoreRowModel: getCoreRowModel() });
  return null;
}
