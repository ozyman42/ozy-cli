import { makeCommand } from '../../common/command';
import { Ok } from '../../common/result';

export const setup = makeCommand('setup', 'configure a new npm package for publishing', async () => {
  // TODO: automate npm package publish setup
  return Ok(true);
});
