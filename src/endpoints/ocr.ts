import { OpenAPIRoute, Str } from "chanfana";
import { z } from "zod";
import {
  AppContext,
  JsonRequestSchema,
  OcrResponseSchema,
  TaskType,
  TaskTypeSchema,
} from "../types";
import { handleOcrRequest } from "../lib/ocr";

const MultipartSchema = z.object({
  image: Str({
    description: "通过 multipart/form-data 上传的图像或 PDF 文件（binary）",
  }),
  prompt: Str({ description: "可选的追加提示词", required: false }),
  text: Str({ description: "文本定位任务需要的特定文字", required: false }),
  taskType: TaskTypeSchema.describe("当调用通用端点时必填").optional(),
});

const RequestContent = {
  "multipart/form-data": {
    schema: MultipartSchema,
  },
  "application/json": {
    schema: JsonRequestSchema,
  },
};

const ResponseContent = {
  "application/json": {
    schema: OcrResponseSchema,
  },
};

const BaseResponses = {
  "200": { description: "请求成功", content: ResponseContent },
  "400": { description: "请求参数错误", content: ResponseContent },
  "413": { description: "文件过大", content: ResponseContent },
  "415": { description: "不支持的 Content-Type", content: ResponseContent },
  "500": { description: "服务异常", content: ResponseContent },
};

function buildSchema(summary: string) {
  return {
    tags: ["OCR"],
    summary,
    request: {
      body: {
        content: RequestContent,
      },
    },
    responses: BaseResponses,
  };
}

export class OcrTaskRoute extends OpenAPIRoute {
  schema = buildSchema("通用 OCR 任务提交入口");

  async handle(c: AppContext) {
    return handleOcrRequest(c);
  }
}

function createAliasRoute(taskType: TaskType, summary: string) {
  return class extends OpenAPIRoute {
    schema = buildSchema(summary);

    async handle(c: AppContext) {
      return handleOcrRequest(c, { forcedTaskType: taskType });
    }
  };
}

export const OcrConvertRoute = createAliasRoute(
  "document_markdown",
  "文档转 Markdown",
);
export const OcrGeneralRoute = createAliasRoute("general_ocr", "通用 OCR");
export const OcrSimpleRoute = createAliasRoute(
  "plaintext_ocr",
  "无布局文本提取",
);
export const OcrChartRoute = createAliasRoute("chart_parse", "图表解析");
export const OcrDescribeRoute = createAliasRoute("image_caption", "图像描述");
export const OcrLocateRoute = createAliasRoute("text_localization", "文本定位");
