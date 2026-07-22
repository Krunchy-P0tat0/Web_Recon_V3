/**
 * Storage.tsx — Cloud Storage management page.
 * Ported from V2, adapted for V1's /api/storage/* endpoints.
 */
import { useState, useRef } from "react";
import { useStorageStatus, useStorageUpload, useStorageDelete, downloadStorageFile } from "@/hooks/use-storage";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Database, UploadCloud, Download, Trash2, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export default function Storage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isEncoding, setIsEncoding] = useState(false);
  const [downloadKey, setDownloadKey] = useState("");
  const [deleteKey, setDeleteKey] = useState("");

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useStorageStatus();
  const uploadMutation = useStorageUpload();
  const deleteMutation = useStorageDelete();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsEncoding(true);
    try {
      await new Promise<void>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const base64Data = (event.target?.result as string).split(",")[1];
            if (!base64Data) throw new Error("Failed to encode file");
            await uploadMutation.mutateAsync({
              key: file.name,
              contentBase64: base64Data,
              contentType: file.type || "application/octet-stream",
            });
            if (fileInputRef.current) fileInputRef.current.value = "";
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error("FileReader error"));
        reader.readAsDataURL(file);
      });
    } catch {
      toast.error("Error reading file");
    } finally {
      setIsEncoding(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadKey) return;
    try {
      await downloadStorageFile(downloadKey);
      setDownloadKey("");
    } catch {
      toast.error("Failed to download file. It might not exist.");
    }
  };

  const handleDelete = async () => {
    if (!deleteKey) return;
    try {
      await deleteMutation.mutateAsync(deleteKey);
      setDeleteKey("");
    } catch {
      // Error handled in mutation
    }
  };

  const isReady = status?.configured && !statusLoading;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2 font-mono text-primary flex items-center gap-2">
            <Database className="h-6 w-6" /> STORAGE_SUBSYSTEM
          </h1>
          <p className="text-muted-foreground text-sm">
            Manage objects and configuration for the cloud storage module.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetchStatus()} disabled={statusLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${statusLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Status Card */}
      <Card className="border-l-4 border-l-secondary bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-mono text-muted-foreground">MOUNT_STATUS</CardTitle>
        </CardHeader>
        <CardContent>
          {statusLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" /> Checking provider…
            </div>
          ) : status?.configured ? (
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-medium font-mono text-primary">PROVIDER READY</p>
                <p className="text-xs text-muted-foreground">
                  Active provider: <span className="font-mono">{status.provider}</span>
                </p>
              </div>
              <Badge variant="outline" className="ml-auto font-mono text-xs border-primary/40 text-primary">
                CONFIGURED
              </Badge>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-warning" />
              <div>
                <p className="text-sm font-medium font-mono text-warning">PROVIDER NOT CONFIGURED</p>
                <p className="text-xs text-muted-foreground">
                  Set R2 or local storage credentials to enable uploads.
                </p>
              </div>
              <Badge variant="outline" className="ml-auto font-mono text-xs border-warning/40 text-warning">
                UNCONFIGURED
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Upload Panel */}
        <Card className={`md:col-span-1 ${!isReady ? "opacity-50 pointer-events-none" : ""}`}>
          <CardHeader>
            <CardTitle className="font-mono text-base flex items-center gap-2">
              <UploadCloud className="h-4 w-4 text-primary" /> UPLOAD_OBJECT
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">Select a file to upload to the active storage provider.</p>
            <input
              ref={fileInputRef}
              type="file"
              onChange={(e) => void handleFileSelect(e)}
              className="hidden"
              id="file-upload"
            />
            <label
              htmlFor="file-upload"
              className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 transition-colors"
            >
              <UploadCloud className="h-6 w-6 text-muted-foreground mb-1" />
              <span className="text-xs text-muted-foreground font-mono">
                {isEncoding || uploadMutation.isPending ? "Uploading…" : "CLICK_TO_SELECT"}
              </span>
            </label>
          </CardContent>
        </Card>

        {/* Download Panel */}
        <Card className={`md:col-span-1 ${!isReady ? "opacity-50 pointer-events-none" : ""}`}>
          <CardHeader>
            <CardTitle className="font-mono text-base flex items-center gap-2">
              <Download className="h-4 w-4 text-chart-2" /> DOWNLOAD_OBJECT
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground">OBJECT_KEY</label>
              <input
                type="text"
                value={downloadKey}
                onChange={(e) => setDownloadKey(e.target.value)}
                placeholder="e.g. data.csv"
                className="w-full bg-background border border-input rounded-md h-9 px-3 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
              variant="secondary"
              onClick={() => void handleDownload()}
              disabled={!isReady || !downloadKey}
            >
              Download
            </Button>
          </CardFooter>
        </Card>

        {/* Delete Panel */}
        <Card className={`md:col-span-1 border-destructive/20 ${!isReady ? "opacity-50 pointer-events-none" : ""}`}>
          <CardHeader>
            <CardTitle className="font-mono text-base flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4" /> DELETE_OBJECT
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground">OBJECT_KEY</label>
              <input
                type="text"
                value={deleteKey}
                onChange={(e) => setDeleteKey(e.target.value)}
                placeholder="e.g. data.csv"
                className="w-full bg-background border border-input rounded-md h-9 px-3 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive"
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={!isReady || !deleteKey || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
              Obliterate
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
