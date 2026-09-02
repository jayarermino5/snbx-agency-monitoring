# Official Playwright image — has all dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies (skip playwright browser download — already in image)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

# Copy source
COPY . .

# Railway sets PORT automatically
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
