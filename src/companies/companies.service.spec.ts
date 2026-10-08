import { ConflictException, NotFoundException } from '@nestjs/common';
import { CompaniesService } from './companies.service';

describe('CompaniesService', () => {
  const model = {
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  };
  const service = new CompaniesService(model as never);

  beforeEach(() => jest.clearAllMocks());

  it('looks up only the authenticated company id', async () => {
    model.findById.mockResolvedValue({ _id: 'company-a', name: 'Acme' });
    await expect(service.findCurrent('company-a')).resolves.toMatchObject({
      name: 'Acme',
    });
    expect(model.findById).toHaveBeenCalledWith('company-a');
  });

  it('returns not found for a missing company', async () => {
    model.findById.mockResolvedValue(null);
    await expect(service.findCurrent('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps duplicate company names to a conflict', async () => {
    model.findByIdAndUpdate.mockRejectedValue({
      code: 11000,
      keyPattern: { name: 1 },
    });
    await expect(
      service.updateCurrent('company-a', { name: 'Existing' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
