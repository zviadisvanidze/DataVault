import { PassThrough } from 'node:stream';
import { PromptIO, hiddenPrompt } from './hidden-prompt';
import { CliFailureCategory } from './cli-errors';

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: jest.fn(function (this: { isRaw: boolean }, raw: boolean) {
      this.isRaw = raw;
      return this;
    }),
  });
  const write = jest.fn().mockReturnValue(true);
  const io = { input, output: { isTTY: true, write } } as unknown as PromptIO;
  return { input, write, io };
}
describe('hidden interactive credential input', () => {
  it('does not echo answers, restores terminal mode, and supports split UTF-8 input/backspace', async () => {
    const f = terminal();
    const pending = hiddenPrompt('Password (hidden): ', f.io);
    const unicode = Buffer.from('é');
    f.input.write(unicode.subarray(0, 1));
    f.input.write(unicode.subarray(1));
    f.input.write('secretX\u007f\r');
    expect(await pending).toBe('ésecret');
    expect(f.write.mock.calls).toEqual([['Password (hidden): '], ['\n']]);
    expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount('data')).toBe(0);
  });
  it.each(['\u0003', '\u0004'])(
    'cancels without revealing a partial credential (%j)',
    async (cancel) => {
      const f = terminal();
      const pending = hiddenPrompt('Hidden: ', f.io);
      f.input.write(`private-token${cancel}`);
      await expect(pending).rejects.toThrow(
        CliFailureCategory.OPERATOR_CANCELLED,
      );
      expect(JSON.stringify(f.write.mock.calls)).not.toContain('private-token');
      expect(f.input.isRaw).toBe(false);
    },
  );
  it('refuses noninteractive input before consuming or echoing credentials', async () => {
    const f = terminal();
    f.input.isTTY = false;
    await expect(hiddenPrompt('Hidden: ', f.io)).rejects.toThrow(
      CliFailureCategory.INVALID_SMOKE_CONFIGURATION,
    );
    expect(f.write).not.toHaveBeenCalled();
    expect(f.input.setRawMode).not.toHaveBeenCalled();
  });
  it('uses a caller-selected safe configuration category', async () => {
    const f = terminal();
    f.input.isTTY = false;
    await expect(
      hiddenPrompt(
        'Hidden: ',
        f.io,
        CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION,
      ),
    ).rejects.toThrow(
      CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION,
    );
  });
  it('removes bracketed-paste markers even when terminal sequences are split across chunks', async () => {
    const f = terminal();
    const pending = hiddenPrompt('Hidden: ', f.io);
    f.input.write('\u001b[20');
    f.input.write('0~pasted-secret');
    f.input.write('\u001b[2');
    f.input.write('01~\r');
    expect(await pending).toBe('pasted-secret');
  });
  it('rejects multiline bracketed paste instead of changing a credential', async () => {
    const f = terminal();
    const pending = hiddenPrompt('Hidden: ', f.io);
    f.input.write('\u001b[200~first\nsecond\u001b[201~');
    await expect(pending).rejects.toThrow(
      CliFailureCategory.INVALID_SMOKE_CONFIGURATION,
    );
  });
});
