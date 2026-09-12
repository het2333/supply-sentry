process.env['READYWORK_API_SURFACE'] = 'business';
process.env['PORT'] ??= '4173';
await import('../../api/src/index.js');
export {};
