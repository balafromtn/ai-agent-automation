const { execute } = require('../agents/handlers/file.handler');
const fs = require('fs');


jest.mock('fs');
jest.mock('../agents/utils/fileResolver', () => ({
  resolveWorkflowFilePath: jest.fn((p) => `/mocked/safe/path/${p}`)
}));

describe('File Handler', () => {
  it('should simulate reading a file', async () => {
    fs.readFileSync.mockReturnValue('simulated file content');
    const step = { config: { action: 'read', path: 'dummy.txt' } };
    const validatedStepId = 'file-123';
    const result = await execute(step, {}, null, validatedStepId, 5000);

    expect(result.success).toBe(true);
    expect(result.type).toBe('file');
    expect(result.output).toBe('simulated file content');
  });
});