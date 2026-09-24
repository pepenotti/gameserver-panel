import { createTheme, type MantineColorsTuple } from '@mantine/core';

// A burnt-orange accent: warning signs and rust, fitting for Knox County.
const rust: MantineColorsTuple = ['#fff1e7', '#ffe1cf', '#fcc19e', '#f99f69', '#f6823c', '#f56f20', '#f56512', '#da5405', '#c24900', '#aa3c00'];

export const theme = createTheme({
  primaryColor: 'rust',
  colors: { rust },
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontFamilyMonospace: 'ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace',
  headings: { fontWeight: '650' },
});
