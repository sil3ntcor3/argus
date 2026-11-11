/** Only development and tests are local; deployed images may leave NODE_ENV unset. */
export const isLocalEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
