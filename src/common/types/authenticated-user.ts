import { Role } from '../../enums/roles.enum';

export interface AuthenticatedUser {
  id: string;
  companyId: string;
  role: Role;
}
