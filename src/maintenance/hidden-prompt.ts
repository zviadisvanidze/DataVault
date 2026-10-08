import { CliFailure, CliFailureCategory } from './cli-errors';
import { StringDecoder } from 'node:string_decoder';
import { ReadStream, WriteStream } from 'node:tty';

export interface PromptIO {
  input: Pick<
    ReadStream,
    | 'isTTY'
    | 'isRaw'
    | 'setRawMode'
    | 'resume'
    | 'pause'
    | 'on'
    | 'once'
    | 'removeListener'
  >;
  output: Pick<WriteStream, 'isTTY' | 'write'>;
}

/** No echo/masking, argv secrets, redirected stdin, or persisted answers. */
export function hiddenPrompt(
  prompt: string,
  io: PromptIO = { input: process.stdin, output: process.stdout },
  invalidCategory = CliFailureCategory.INVALID_SMOKE_CONFIGURATION,
): Promise<string> {
  const { input, output } = io;
  if (!input.isTTY || !output.isTTY)
    return Promise.reject(new CliFailure(invalidCategory));
  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let answer = '';
    let terminalSequence = '';
    let bracketedPaste = false;
    let invalidPastedLineBreak = false;
    const decoder = new StringDecoder('utf8');
    const finish = (error?: CliFailure) => {
      input.removeListener('data', receive);
      input.removeListener('end', cancelled);
      input.removeListener('error', cancelled);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) {
        answer = '';
        reject(error);
      } else {
        resolve(answer);
        answer = '';
      }
    };
    const cancelled = () =>
      finish(new CliFailure(CliFailureCategory.OPERATOR_CANCELLED));
    const receive = (buffer: Buffer) => {
      for (const character of decoder.write(buffer)) {
        if (terminalSequence) {
          terminalSequence += character;
          const expected = bracketedPaste ? '\u001b[201~' : '\u001b[200~';
          if (terminalSequence === expected) {
            terminalSequence = '';
            bracketedPaste = !bracketedPaste;
            if (!bracketedPaste && invalidPastedLineBreak) {
              finish(new CliFailure(invalidCategory));
              return;
            }
          } else if (!expected.startsWith(terminalSequence)) {
            // Ignore unsupported terminal escape sequences instead of treating
            // their printable suffix as part of a credential.
            terminalSequence = '';
          }
          continue;
        }
        if (character === '\u001b') {
          terminalSequence = character;
          continue;
        }
        if (character === '\u0003' || character === '\u0004') {
          cancelled();
          return;
        }
        if (character === '\r' || character === '\n') {
          if (bracketedPaste) {
            invalidPastedLineBreak = true;
            continue;
          }
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          answer = Array.from(answer).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ' && character !== '\u007f') answer += character;
        if (answer.length > 4096) {
          cancelled();
          return;
        }
      }
    };
    input.on('data', receive);
    input.once('end', cancelled);
    input.once('error', cancelled);
  });
}
