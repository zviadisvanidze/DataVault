import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSender } from './email-sender';
import { createEmailSender } from './email-sender.provider';
import { EmailService } from './email.service';

@Module({
  providers: [
    EmailService,
    {
      provide: EmailSender,
      inject: [ConfigService],
      useFactory: createEmailSender,
    },
  ],
  exports: [EmailService, EmailSender],
})
export class EmailModule {}
