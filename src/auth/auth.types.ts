import { Request } from 'express';
import { AuthenticatedUser } from '../common/types/authenticated-user';

export interface AuthenticatedRequest extends Request {
  auth?: AuthenticatedUser;
}

export interface TokenPayload {
  id: string;
  type?: string;
  version?: number;
}

export interface GoogleUser {
  email: string;
  fullName: string;
  avatar?: string;
}
