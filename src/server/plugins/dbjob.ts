import { CronJob, CronTime } from "cron";
import path from 'path';
import fs from 'fs';
import { writeFile } from 'fs/promises'
import Package from '../../../package.json';
import { $ } from 'execa';
import AdmZip from 'adm-zip'
import { ARCHIVE_BLINKO_TASK_NAME, DBBAK_TASK_NAME, DBBAKUP_PATH, ROOT_PATH, TEMP_PATH, UPLOAD_FILE_PATH } from "@/lib/constant";
import { prisma } from "../prisma";
import { unlink } from "fs/promises";
import { createCaller } from "../routers/_app";
import { Context } from "../context";

export type RestoreResult = {
  type: 'success' | 'skip' | 'error';
  content?: string;
  error?: unknown;
  progress?: { current: number; total: number };
}
export type ExportTimeRange = 'day' | 'week' | 'month' | 'quarter';


export class DBJob {
  static Job = new CronJob('* * * * *', async () => {
    try {
      const res = await DBJob.RunTask()
      await prisma.scheduledTask.update({ where: { name: DBBAK_TASK_NAME }, data: { isSuccess: true, output: res, lastRun: new Date() } })
    } catch (error) {
      await prisma.scheduledTask.update({ where: { name: DBBAK_TASK_NAME }, data: { isSuccess: false, output: { error: error.message ?? 'internal error' } } })
    }
  }, null, false);

  static async RunTask() {
    try {
      const notes = await prisma.notes.findMany({
        select: {
          id: true,
          account: true,
          content: true,
          isArchived: true,
          isShare: true,
          isTop: true,
          createdAt: true,
          updatedAt: true,
          type: true,
          attachments: true,
          tags: true,
          references: true,
          referencedBy: true
        }
      });
      const exportData = {
        notes,
        exportTime: new Date(),
        version: Package.version
      };

      fs.writeFileSync(
        `${DBBAKUP_PATH}/bak.json`,
        JSON.stringify(exportData, null, 2)
      );

      const targetFile = UPLOAD_FILE_PATH + `/blinko_export.bko`;
      try {
        await unlink(targetFile);
      } catch (error) {
      }

      const zip = new AdmZip();
      zip.addLocalFolder(ROOT_PATH);
      zip.writeZip(targetFile);

      return { filePath: `/api/file/blinko_export.bko` };
    } catch (error) {
      throw new Error(error)
    }
  }

  static async *RestoreDB(filePath: string, ctx: any): AsyncGenerator<RestoreResult & { progress: { current: number; total: number } }, void, unknown> {
    try {
      const zip = new AdmZip(filePath);
      zip.extractAllTo(ROOT_PATH, true);

      const backupData = JSON.parse(
        fs.readFileSync(`${DBBAKUP_PATH}/bak.json`, 'utf-8')
      );

      const attachmentsCount = backupData.notes.reduce((acc, note) =>
        acc + (note.attachments?.length || 0), 0);
      const total = backupData.notes.length + attachmentsCount - 1;
      let current = 0;

      for (const note of backupData.notes) {
        current++;
        try {
          const userCaller = createCaller(ctx)

          const createdNote = await userCaller.notes.upsert({
            content: note.content,
            isArchived: note.isArchived,
            type: note.type,
            isTop: note.isTop,
            isShare: note.isShare,
          })

          if (createdNote.id) {
            const account = await prisma.accounts.findFirst({
              where: { name: note.account.name }
            })
            let updateData: any = {
              createdAt: note.createdAt,
              updatedAt: note.updatedAt,
            }
            if (!account) {
              const _newAccount = await prisma.accounts.create({
                data: {
                  name: note.account.name,
                  password: note.account.password,
                  role: 'user'
                }
              })
              updateData.accountId = _newAccount.id
            } else {
              updateData.accountId = account.id
            }
            await prisma.notes.update({
              where: { id: createdNote.id },
              data: updateData
            });
          }

          yield {
            type: 'success',
            content: note.content.slice(0, 30),
            progress: { current, total }
          };

          if (note.attachments?.length) {
            for (const attachment of note.attachments) {
              current++;
              try {
                const existingAttachment = await prisma.attachments.findFirst({
                  where: { name: attachment.name }
                });
                await prisma.attachments.create({
                  data: {
                    ...attachment,
                    noteId: createdNote.id
                  }
                });

                yield {
                  type: 'success',
                  content: attachment.name,
                  progress: { current, total }
                };
              } catch (error) {
                yield {
                  type: 'error',
                  content: attachment.name,
                  error,
                  progress: { current, total }
                };
              }
            }
          }
        } catch (error) {
          yield {
            type: 'error',
            content: note.content.slice(0, 30),
            error,
            progress: { current, total }
          };
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        error,
        content: error.message ?? 'internal error',
        progress: { current: 0, total: 0 }
      };
    }
  }

  static async Start(cronTime: string, immediate: boolean = true) {
    let success = false, output
    const hasTask = await prisma.scheduledTask.findFirst({ where: { name: DBBAK_TASK_NAME } })
    DBJob.Job.setTime(new CronTime(cronTime))
    DBJob.Job.start()
    if (immediate) {
      try {
        output = await DBJob.RunTask()
        success = true
      } catch (error) { output = error ?? (error.message ?? "internal error") }
    }
    if (!hasTask) {
      return await prisma.scheduledTask.create({ data: { lastRun: new Date(), output, isSuccess: success, schedule: cronTime, name: DBBAK_TASK_NAME, isRunning: DBJob.Job.running } })
    } else {
      return await prisma.scheduledTask.update({ where: { name: DBBAK_TASK_NAME }, data: { lastRun: new Date(), output, isSuccess: success, schedule: cronTime, isRunning: DBJob.Job.running } })
    }
  }

  static async Stop() {
    DBJob.Job.stop()
    return await prisma.scheduledTask.update({ where: { name: DBBAK_TASK_NAME }, data: { isRunning: DBJob.Job.running } })
  }

  static async SetCornTime(cronTime: string) {
    DBJob.Job.setTime(new CronTime(cronTime))
    await this.Start(cronTime, true)
    // return await prisma.scheduledTask.update({ where: { name: DBBAK_TASK_NAME }, data: { schedule: cronTime, lastRun: new Date() } })
  }

  static async ExporMDFiles(params: {
    baseURL: string;
    startDate?: Date;
    endDate?: Date;
    ctx: Context;
    format: 'markdown' | 'csv' | 'json';
  }) {
    const { baseURL, startDate, endDate, ctx, format } = params;
    const notes = await prisma.notes.findMany({
      where: {
        createdAt: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate })
        },
        accountId: Number(ctx.id)
      },
      select: {
        id: true,
        content: true,
        attachments: true,
        createdAt: true,
      }
    });
    if (notes.length === 0) {
      throw new Error('No notes found');
    }
    const exportDir = path.join(TEMP_PATH, 'exports');
    const attachmentsDir = path.join(exportDir, 'files');
    const zipFilePath = TEMP_PATH + `/notes_export_${Date.now()}.zip`;

    try {
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      if (!fs.existsSync(attachmentsDir)) {
        fs.mkdirSync(attachmentsDir, { recursive: true });
      }

      if (format === 'csv') {
        const csvContent = ['ID,Content,Created At'].concat(
          notes.map(note => `${note.id},"${note.content.replace(/"/g, '""')}",${note.createdAt.toISOString()}`)
        ).join('\n');
        await writeFile(path.join(exportDir, 'notes.csv'), csvContent);
      } else if (format === 'json') {
        await writeFile(
          path.join(exportDir, 'notes.json'),
          JSON.stringify(notes, null, 2)
        );
      } else {
        await Promise.all(notes.map(async (note) => {
          let mdContent = note.content;

          if (note.attachments?.length) {
            await Promise.all(note.attachments.map(async (attachment) => {
              try {
                const response = await fetch(`${baseURL}${attachment.path}`);
                const buffer = await response.arrayBuffer();
                const attachmentPath = path.join(attachmentsDir, attachment.name);
                //@ts-ignore
                await writeFile(attachmentPath, Buffer.from(buffer));

                const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(attachment.name);

                if (isImage) {
                  mdContent += `\n![${attachment.name}](./files/${attachment.name})`;
                } else {
                  mdContent += `\n[${attachment.name}](./files/${attachment.name})`;
                }
              } catch (error) {
                console.error(`Failed to download attachment: ${attachment.name}`, error);
              }
            }));
          }

          const fileName = `note-${note.id}-${note.createdAt.getTime()}.md`;
          await writeFile(path.join(exportDir, fileName), mdContent);
        }));
      }

      const zip = new AdmZip();
      zip.addLocalFolder(exportDir);
      zip.writeZip(zipFilePath);

      fs.rmSync(exportDir, { recursive: true, force: true });
      return {
        success: true,
        path: zipFilePath.replace(UPLOAD_FILE_PATH, ''),
        fileCount: notes.length
      };
    } catch (error) {
      try {
        if (fs.existsSync(exportDir)) {
          fs.rmSync(exportDir, { recursive: true, force: true });
        }
        if (fs.existsSync(zipFilePath)) {
          fs.unlinkSync(zipFilePath);
        }
      } catch { }
      throw error;
    }
  }
}