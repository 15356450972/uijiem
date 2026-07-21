import('./main.cjs').catch((error) => {
  console.error('[main] failed to load electron/main.cjs:', error);
  process.exitCode = 1;
});
