import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company } from './entities/company.entity';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { isDuplicateKeyError } from '../users/database-errors';

@Injectable()
export class CompaniesService {
  constructor(
    @InjectModel('company') private readonly companyModel: Model<Company>,
  ) {}

  async findCurrent(companyId: string) {
    const company = await this.companyModel.findById(companyId);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async updateCurrent(companyId: string, dto: UpdateCompanyDto) {
    try {
      const company = await this.companyModel.findByIdAndUpdate(
        companyId,
        dto,
        {
          new: true,
          runValidators: true,
        },
      );
      if (!company) throw new NotFoundException('Company not found');
      return company;
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new ConflictException('Company name is already in use');
      throw error;
    }
  }
}
