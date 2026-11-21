import { Controller, Get, Header } from "@nestjs/common";
import { OPENAPI_SPEC } from "./openapi.spec";

@Controller("docs")
export class SwaggerController {
    @Get("openapi.json")
    getSpec() {
        return OPENAPI_SPEC;
    }

    @Get()
    @Header("Content-Type", "text/html; charset=utf-8")
    getUi(): string {
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Distributed Wagering Processor — Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({ url: "/docs/openapi.json", dom_id: "#swagger-ui" });
    };
  </script>
</body>
</html>`;
    }
}