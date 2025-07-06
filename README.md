Holograms Against Humanity
==========================

A terrible game for terrible Banters. This is a clone of Cards Against Humanity designed to be played in the social platform BanterVR.

## Local Development

1.  **Prerequisites**: Make sure you have Node.js installed.
2.  **Clone Repository**: Clone this project to your local machine.
3.  **Install Dependencies**: Open a terminal in the project root and run:
    ```bash
    npm install
    ```
4.  **Start Server**: Run the following command to start the local server:
    ```bash
    npm start
    ```
5.  You can now access the game at `http://localhost:3000`.

## Deployment to Render

This application is ready to be deployed on Render.

1.  **Push to GitHub**: Make sure your latest code is pushed to a GitHub repository.
2.  **Create a Web Service on Render**:
    *   In your Render dashboard, click **New +** and select **Web Service**.
    *   Connect your GitHub account and select the repository for this project.
3.  **Configure the Service**:
    *   **Runtime**: Render will auto-detect `Node`.
    *   **Build Command**: `npm install`
    *   **Start Command**: `npm start`
4.  Click **Create Web Service**. Render will build and deploy your app. Once it's live, you can access it at the URL Render provides (e.g., `https://your-app-name.onrender.com`).
