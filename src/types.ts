import type { Context } from "hono";
import { z } from "zod";

export type AppBindings = {
  Bindings: {
    SILICONFLOW_API_KEY: string;
    SILICONFLOW_BASE_URL?: string;
    SILICONFLOW_MODEL_ID?: string;
    MAX_FILE_SIZE?: string;
    SUPPORTED_FORMATS?: string;
  };
};

export type AppContext = Context<AppBindings>;

export const TaskTypeSchema = z.enum([
  "document_markdown",
  "general_ocr",
  "plaintext_ocr",
  "chart_parse",
  "image_caption",
  "text_localization",
]);

export type TaskType = z.infer<typeof TaskTypeSchema>;

export const JsonRequestSchema = z.object({
  taskType: TaskTypeSchema.optional(),
  image: z.string({ description: "base64 编码的文件内容" }).min(1),
  filename: z.string().optional(),
  prompt: z.string().optional(),
  text: z.string().optional(),
});

export type JsonRequest = z.infer<typeof JsonRequestSchema>;

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.string().optional(),
});

export const OcrResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      text: z.string(),
      confidence: z.number().optional(),
      processingTime: z.number(),
      model: z.string(),
      taskType: TaskTypeSchema,
      promptUsed: z.string(),
      filename: z.string(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export type OcrResponse = z.infer<typeof OcrResponseSchema>;

export type ApiError = z.infer<typeof ErrorSchema>;

export type TaskConfig = {
  id: TaskType;
  defaultPrompt: string;
  requiresTargetText?: boolean;
  allowCustomPrompt?: boolean;
};

export type ParsedInput = {
  file: File;
  filename: string;
  taskType: TaskType;
  customPrompt?: string;
  targetText?: string;
};
