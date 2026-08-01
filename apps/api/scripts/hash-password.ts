import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

/**
 * One-off: generate ADMIN_PASSWORD_HASH. Plaintext never touches the repo, the
 * database, or the container — it exists only in the operator's terminal.
 *
 *   pnpm hash-password 'the password'
 *   pnpm hash-password              # generates a strong one and prints it once
 */
async function main(): Promise<void> {
  const supplied = process.argv[2];
  const generated = supplied ?? randomBytes(24).toString('base64url');

  const hash = await argon2.hash(generated, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });

  if (!supplied) {
    console.log('\nGenerated password (shown once — store it in a password manager):');
    console.log(`  ${generated}\n`);
  }
  console.log('Add this to your .env:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
}

void main();
