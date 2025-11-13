import { fromHono } from "chanfana";
import { Hono } from "hono";
import {
  OcrChartRoute,
  OcrConvertRoute,
  OcrDescribeRoute,
  OcrGeneralRoute,
  OcrLocateRoute,
  OcrSimpleRoute,
  OcrTaskRoute,
} from "./endpoints/ocr";
import type { AppBindings } from "./types";

// Start a Hono app
const app = new Hono<AppBindings>();

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/",
});

// Register OpenAPI endpoints
openapi.post("/api/ocr", OcrTaskRoute);
openapi.post("/api/ocr/convert", OcrConvertRoute);
openapi.post("/api/ocr/general", OcrGeneralRoute);
openapi.post("/api/ocr/simple", OcrSimpleRoute);
openapi.post("/api/ocr/chart", OcrChartRoute);
openapi.post("/api/ocr/describe", OcrDescribeRoute);
openapi.post("/api/ocr/locate", OcrLocateRoute);

// You may also register routes for non OpenAPI directly on Hono
// app.get('/test', (c) => c.text('Hono!'))

// Export the Hono app
export default app;
