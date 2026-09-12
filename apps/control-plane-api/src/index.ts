process.env['READYWORK_API_SURFACE'] = 'control';
process.env['PORT'] ??= '4174';
await import('../../api/src/index.js');
export {};
