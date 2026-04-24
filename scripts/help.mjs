#!/usr/bin/env node
// Lists all available scripts in ux-mind-helpers

console.log(`ux-mind-helpers — reusable codemod scripts for UX Mind projects

Scripts:
  fix-relative-imports          Replace ../ imports with path alias (~/, @/)
  migrate-tailwind-arbitraries  Convert arbitrary Tailwind values to predefined classes
  react-namespace-imports       Flatten 'import * as React' to named imports
  lucide-icon-suffix            Append 'Icon' suffix to lucide-react imports

Usage:
  pnpm dlx --package github:antonchuvirau/ux-mind-helpers <script> [options]
  pnpm dlx --package github:antonchuvirau/ux-mind-helpers <script> --help`);
