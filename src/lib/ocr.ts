import { z } from "zod";
import {
  AppContext,
  JsonRequestSchema,
  ParsedInput,
  TaskConfig,
  TaskType,
  TaskTypeSchema,
} from "../types";

class OcrError extends Error {
  status: number;
  code: string;
  details?: string;
  constructor(status: number, code: string, message: string, details?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_SUPPORTED_FORMATS = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/webp",
  "application/pdf",
];

export const TASK_CONFIGS: Record<TaskType, TaskConfig> = {
  document_markdown: {
    id: "document_markdown",
    defaultPrompt: "<image>\n<|grounding|>Convert the document to markdown.",
  },
  general_ocr: {
    id: "general_ocr",
    defaultPrompt: "<image>\n<|grounding|>OCR this image.",
  },
  plaintext_ocr: {
    id: "plaintext_ocr",
    defaultPrompt: "<image>\nFree OCR.",
  },
  chart_parse: {
    id: "chart_parse",
    defaultPrompt: "<image>\nParse the figure.",
  },
  image_caption: {
    id: "image_caption",
    defaultPrompt: "<image>\nDescribe this image in detail.",
  },
  text_localization: {
    id: "text_localization",
    defaultPrompt: "<image>\nLocate <|ref|>{{target}}<|/ref|> in the image.",
    requiresTargetText: true,
    allowCustomPrompt: true,
  },
};

type ProcessOptions = {
  forcedTaskType?: TaskType;
};

export async function handleOcrRequest(
  c: AppContext,
  options: ProcessOptions = {},
) {
  try {
    const payload = await parseInput(c, options.forcedTaskType);
    const config = TASK_CONFIGS[payload.taskType];
    const finalPrompt = buildPrompt(
      config,
      payload.customPrompt,
      payload.targetText,
    );
    validateFile(payload.file, payload.filename, c.env);
    const fileInfo = await prepareFile(payload.file, payload.filename);
    const started = performance.now();
    const result = await invokeSiliconFlow({
      base64: fileInfo.base64,
      mimeType: fileInfo.mimeType,
      prompt: finalPrompt,
      env: c.env,
    });
    const processingTime = Number((performance.now() - started).toFixed(2));
    return c.json(
      {
        success: true,
        data: {
          text: result.text,
          confidence: result.confidence,
          processingTime,
          model: result.model,
          taskType: payload.taskType,
          promptUsed: finalPrompt,
          filename: fileInfo.filename,
        },
      },
      200,
    );
  } catch (error) {
    return handleError(c, error);
  }
}

function handleError(c: AppContext, error: unknown) {
  if (error instanceof OcrError) {
    return Response.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      { status: error.status },
    );
  }
  console.error("Unexpected OCR error", error);
  return Response.json(
    {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试。",
      },
    },
    { status: 500 },
  );
}

async function parseInput(
  c: AppContext,
  forced?: TaskType,
): Promise<ParsedInput> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return parseMultipart(c, forced);
  }
  if (contentType.includes("application/json")) {
    return parseJson(c, forced);
  }
  throw new OcrError(
    415,
    "UNSUPPORTED_CONTENT_TYPE",
    "仅支持 multipart/form-data 或 application/json 请求。",
  );
}

async function parseMultipart(
  c: AppContext,
  forced?: TaskType,
): Promise<ParsedInput> {
  const body = await c.req.parseBody();
  const file = first(body.image);
  if (!(file instanceof File)) {
    throw new OcrError(400, "INVALID_FILE", "请上传有效的图像或 PDF 文件。");
  }
  const customPrompt = normalizeString(first(body.prompt));
  const targetText = normalizeString(first(body.text));
  const taskType = resolveTaskType(
    forced,
    normalizeString(first(body.taskType)),
  );
  return {
    file,
    filename: file.name || "upload",
    taskType,
    customPrompt,
    targetText,
  };
}

async function parseJson(
  c: AppContext,
  forced?: TaskType,
): Promise<ParsedInput> {
  const raw = await c.req.json();
  const parsed = JsonRequestSchema.extend({
    taskType: TaskTypeSchema.optional(),
  }).safeParse(raw);
  if (!parsed.success) {
    throw new OcrError(400, "INVALID_JSON", formatZodError(parsed.error));
  }
  const payload = parsed.data;
  if (!payload.image) {
    throw new OcrError(
      400,
      "MISSING_IMAGE",
      "JSON 请求必须提供 image 字段（base64 编码）。",
    );
  }
  const filename = payload.filename || "upload";
  const bytes = base64ToUint8Array(payload.image);
  const mimeType = inferMimeType(filename) ?? "application/octet-stream";
  const file = new File([bytes], filename, { type: mimeType });
  return {
    file,
    filename,
    taskType: resolveTaskType(forced, payload.taskType),
    customPrompt: normalizeString(payload.prompt),
    targetText: normalizeString(payload.text),
  };
}

function resolveTaskType(forced?: TaskType, candidate?: string): TaskType {
  if (forced) {
    return forced;
  }
  if (!candidate) {
    throw new OcrError(
      400,
      "MISSING_TASK_TYPE",
      "请在请求中提供 taskType 字段。",
    );
  }
  const parsed = TaskTypeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new OcrError(
      400,
      "INVALID_TASK_TYPE",
      "taskType 不在允许的枚举范围内。",
    );
  }
  return parsed.data;
}

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => issue.message).join("; ");
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function first<T>(value: T | T[] | undefined): T | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function buildPrompt(
  config: TaskConfig,
  customPrompt?: string,
  targetText?: string,
) {
  if (config.requiresTargetText && !targetText) {
    throw new OcrError(
      400,
      "MISSING_TARGET_TEXT",
      "文本定位任务需要提供 text 字段。",
    );
  }
  const base = config.requiresTargetText
    ? config.defaultPrompt.replace("{{target}}", targetText ?? "")
    : config.defaultPrompt;
  if (config.allowCustomPrompt && customPrompt) {
    return `${base}\n${customPrompt}`;
  }
  return base;
}

async function prepareFile(file: File, filename: string) {
  const mimeType =
    file.type || inferMimeType(filename) || "application/octet-stream";
  const base64 = await fileToBase64(file);
  return { base64, mimeType, filename };
}

function getMaxFileSize(envValue?: string) {
  if (!envValue) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FILE_SIZE;
}

function parseSupportedFormats(value?: string) {
  if (!value) {
    return DEFAULT_SUPPORTED_FORMATS;
  }
  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed.length > 0 ? parsed : DEFAULT_SUPPORTED_FORMATS;
    }
  } catch (_error) {
    // ignore JSON parse errors
  }
  const list = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_SUPPORTED_FORMATS;
}

function validateFile(file: File, filename: string, env: AppContext["env"]) {
  const maxFileSize = getMaxFileSize(env.MAX_FILE_SIZE);
  if (file.size > maxFileSize) {
    throw new OcrError(
      413,
      "FILE_TOO_LARGE",
      `文件大小超出限制（最大 ${Math.round(maxFileSize / 1024 / 1024)}MB）。`,
    );
  }
  const formats = parseSupportedFormats(env.SUPPORTED_FORMATS);
  const mimeType = file.type || inferMimeType(filename) || "";
  if (!isAllowedFormat(formats, mimeType, filename)) {
    throw new OcrError(400, "UNSUPPORTED_FORMAT", "当前文件格式不受支持。");
  }
}

function isAllowedFormat(
  formats: string[],
  mimeType: string,
  filename: string,
) {
  const ext = getExtension(filename);
  const normalizedMime = mimeType.toLowerCase();
  return formats.some((format) => {
    const normalized = format.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.includes("/")) {
      return normalized === normalizedMime;
    }
    if (normalized.startsWith(".")) {
      return ext ? normalized.slice(1) === ext : false;
    }
    return ext ? normalized === ext : false;
  });
}

function getExtension(filename: string) {
  const parts = filename.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  return parts.pop()?.toLowerCase();
}

async function fileToBase64(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string) {
  const cleaned = (
    base64.includes(",") ? (base64.split(",").pop() ?? base64) : base64
  ).replace(/\s/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function inferMimeType(filename?: string) {
  const ext = filename ? getExtension(filename) : undefined;
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

async function invokeSiliconFlow({
  base64,
  mimeType,
  prompt,
  env,
}: {
  base64: string;
  mimeType: string;
  prompt: string;
  env: AppContext["env"];
}) {
  const apiKey = env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new OcrError(
      500,
      "MISSING_API_KEY",
      "未配置 SILICONFLOW_API_KEY 环境变量。",
    );
  }
  const baseUrl = (
    env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn"
  ).replace(/\/$/, "");
  const model = env.SILICONFLOW_MODEL_ID || "deepseek-ai/DeepSeek-OCR";
  const endpoint = `${baseUrl}/v1/chat/completions`;
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    temperature: 0,
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (_error) {
    data = undefined;
  }
  if (!response.ok) {
    const message =
      data?.error?.message || response.statusText || "API 调用失败";
    throw new OcrError(
      response.status,
      "UPSTREAM_ERROR",
      `硅基流动接口错误：${message}`,
      text,
    );
  }
  const { text: resultText, confidence } = extractTextFromResponse(data);
  return {
    text: resultText,
    confidence,
    model: data?.model || model,
  };
}

function extractTextFromResponse(payload: any) {
  const choice = payload?.choices?.[0];
  if (!choice) {
    throw new OcrError(502, "EMPTY_RESPONSE", "OCR 接口未返回有效内容。");
  }
  const content = choice.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  if (!text) {
    throw new OcrError(502, "EMPTY_RESPONSE", "OCR 结果为空，请重试。");
  }
  return {
    text,
    confidence: choice.confidence,
  };
}
