import { model } from 'mongoose';
import { companySchema } from './company.entity';
import { userSchema } from '../../users/entities/user.entity';

describe('tenant schema indexes', () => {
  it('enforces case-insensitive unique company names', () => {
    expect(companySchema.indexes()).toContainEqual([
      { name: 1 },
      expect.objectContaining({
        unique: true,
        collation: { locale: 'en', strength: 2 },
      }),
    ]);
  });

  it('requires every user to have a company', () => {
    expect(userSchema.path('companyId').isRequired).toBe(true);
  });

  it('indexes users by company and role', () => {
    expect(userSchema.indexes()).toContainEqual([
      { companyId: 1, role: 1 },
      expect.any(Object),
    ]);
  });

  it('requires normalized country/industry and defaults new companies to inactive', () => {
    const Company = model('CompanySchemaProfileTest', companySchema);
    const company = new Company({
      name: 'Acme',
      country: ' ge ',
      industry: '  Financial   Services  ',
    });
    expect(company.country).toBe('GE');
    expect(company.industry).toBe('Financial Services');
    expect(company.activatedAt).toBeNull();
    expect(company.validateSync()).toBeUndefined();
    expect(
      new Company({
        name: 'Acme',
        country: 'XX',
        industry: 'Tech',
      }).validateSync(),
    ).toBeDefined();
  });
});
