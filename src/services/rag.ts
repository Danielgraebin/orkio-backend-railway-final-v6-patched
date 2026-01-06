import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';
import { pool } from '../db/index.js';
import { chunkText, cosineSimilarity } from '../utils/index.js';
import { RAGEvidence } from '../types/index.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Document text extraction
export async function extractText(filePath: string, mimeType: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  
  try {
    if (ext === '.txt' || ext === '.md' || mimeType === 'text/plain' || mimeType === 'text/markdown') {
      return fs.readFileSync(filePath, 'utf-8');
    }
    
    if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    
    if (ext === '.pdf' || mimeType === 'application/pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    }
    
    // Fallback: try to read as text
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Error extracting text from ${filePath}:`, error);
    throw new Error(`Failed to extract text from document: ${(error as Error).message}`);
  }
}

// Generate embeddings for text
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      input: text.slice(0, 8000), // Limit input size
    });
    
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw new Error(`Failed to generate embedding: ${(error as Error).message}`);
  }
}

// Process document: extract → chunk → embed → store
export async function processDocument(documentId: string): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Get document info
    const docResult = await client.query(
      'SELECT * FROM documents WHERE id = $1',
      [documentId]
    );
    
    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }
    
    const doc = docResult.rows[0];
    
    // Update status to processing
    await client.query(
      "UPDATE documents SET status = 'processing', updated_at = NOW() WHERE id = $1",
      [documentId]
    );
    
    // Extract text
    console.log(`RAG: Extracting text from ${doc.name}`);
    const text = await extractText(doc.file_path, doc.mime_type);
    
    if (!text || text.trim().length === 0) {
      throw new Error('No text content extracted from document');
    }
    
    console.log(`RAG: Extracted ${text.length} characters from ${doc.name}`);
    
    // Chunk text
    const chunkSize = parseInt(process.env.CHUNK_SIZE || '500');
    const chunkOverlap = parseInt(process.env.CHUNK_OVERLAP || '100');
    const chunks = chunkText(text, chunkSize, chunkOverlap);
    
    console.log(`RAG: Created ${chunks.length} chunks from ${doc.name}`);
    
    // Delete existing embeddings for this document
    await client.query('DELETE FROM embeddings WHERE document_id = $1', [documentId]);
    
    // Generate and store embeddings for each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      try {
        const embedding = await generateEmbedding(chunk);
        
        await client.query(
          `INSERT INTO embeddings (document_id, chunk_index, chunk_text, embedding)
           VALUES ($1, $2, $3, $4)`,
          [documentId, i, chunk, JSON.stringify(embedding)]
        );
        
        console.log(`RAG: Stored embedding ${i + 1}/${chunks.length} for ${doc.name}`);
      } catch (error) {
        console.error(`Error processing chunk ${i}:`, error);
        // Continue with other chunks
      }
    }
    
    // Update document status to completed
    await client.query(
      "UPDATE documents SET status = 'completed', updated_at = NOW() WHERE id = $1",
      [documentId]
    );
    
    console.log(`RAG: Document ${doc.name} processed successfully`);
    
  } catch (error) {
    console.error('Error processing document:', error);
    
    // Update document status to failed
    await client.query(
      "UPDATE documents SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2",
      [(error as Error).message, documentId]
    );
    
    throw error;
  } finally {
    client.release();
  }
}

// Retrieve relevant context for a query
export async function retrieveContext(
  query: string,
  agentId: string,
  tenantId: string,
  topK: number = 5
): Promise<{ context: string; evidence: RAGEvidence[] }> {
  try {
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);
    
    // Get collections linked to this agent + global collections
    const collectionsResult = await pool.query(
      `SELECT DISTINCT c.id 
       FROM collections c
       LEFT JOIN agent_collections ac ON c.id = ac.collection_id
       WHERE c.tenant_id = $1 AND (ac.agent_id = $2 OR c.is_global = true)`,
      [tenantId, agentId]
    );
    
    const collectionIds = collectionsResult.rows.map(r => r.id);
    
    if (collectionIds.length === 0) {
      console.log('RAG: No collections found for agent');
      return { context: '', evidence: [] };
    }
    
    // Get all embeddings from relevant documents
    const embeddingsResult = await pool.query(
      `SELECT e.*, d.name as document_name, d.version as document_version
       FROM embeddings e
       JOIN documents d ON e.document_id = d.id
       WHERE d.collection_id = ANY($1) AND d.status = 'completed'`,
      [collectionIds]
    );
    
    if (embeddingsResult.rows.length === 0) {
      console.log('RAG: No embeddings found in collections');
      return { context: '', evidence: [] };
    }
    
    // Calculate similarity scores
    const scoredChunks = embeddingsResult.rows.map(row => {
      const embedding = typeof row.embedding === 'string' 
        ? JSON.parse(row.embedding) 
        : row.embedding;
      
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      
      return {
        documentId: row.document_id,
        documentName: row.document_name,
        documentVersion: row.document_version,
        chunkIndex: row.chunk_index,
        chunkText: row.chunk_text,
        similarity,
      };
    });
    
    // Sort by similarity and take top K
    scoredChunks.sort((a, b) => b.similarity - a.similarity);
    const topChunks = scoredChunks.slice(0, topK);
    
    // Filter out low similarity results
    const relevantChunks = topChunks.filter(c => c.similarity > 0.3);
    
    if (relevantChunks.length === 0) {
      console.log('RAG: No relevant chunks found (similarity too low)');
      return { context: '', evidence: [] };
    }
    
    // Build context string
    const context = relevantChunks
      .map(c => `[Source: ${c.documentName} v${c.documentVersion}]\n${c.chunkText}`)
      .join('\n\n---\n\n');
    
    // Build evidence array
    const evidence: RAGEvidence[] = relevantChunks.map(c => ({
      document_id: c.documentId,
      document_name: c.documentName,
      document_version: c.documentVersion,
      chunk_text: c.chunkText,
      chunk_index: c.chunkIndex,
      similarity_score: c.similarity,
    }));
    
    console.log(`RAG: Retrieved ${relevantChunks.length} relevant chunks`);
    
    return { context, evidence };
    
  } catch (error) {
    console.error('Error retrieving context:', error);
    return { context: '', evidence: [] };
  }
}

// Check if pgvector is available and use it for similarity search
export async function retrieveContextWithPgVector(
  query: string,
  agentId: string,
  tenantId: string,
  topK: number = 5
): Promise<{ context: string; evidence: RAGEvidence[] }> {
  try {
    // Check if pgvector is available
    const pgvectorCheck = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
    );
    
    if (pgvectorCheck.rows.length === 0) {
      // Fallback to cosine similarity in JavaScript
      return retrieveContext(query, agentId, tenantId, topK);
    }
    
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);
    
    // Get collections linked to this agent + global collections
    const collectionsResult = await pool.query(
      `SELECT DISTINCT c.id 
       FROM collections c
       LEFT JOIN agent_collections ac ON c.id = ac.collection_id
       WHERE c.tenant_id = $1 AND (ac.agent_id = $2 OR c.is_global = true)`,
      [tenantId, agentId]
    );
    
    const collectionIds = collectionsResult.rows.map(r => r.id);
    
    if (collectionIds.length === 0) {
      return { context: '', evidence: [] };
    }
    
    // Use pgvector for similarity search
    const result = await pool.query(
      `SELECT e.*, d.name as document_name, d.version as document_version,
              1 - (e.embedding::vector <=> $1::vector) as similarity
       FROM embeddings e
       JOIN documents d ON e.document_id = d.id
       WHERE d.collection_id = ANY($2) AND d.status = 'completed'
       ORDER BY e.embedding::vector <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(queryEmbedding), collectionIds, topK]
    );
    
    const relevantChunks = result.rows.filter(r => r.similarity > 0.3);
    
    if (relevantChunks.length === 0) {
      return { context: '', evidence: [] };
    }
    
    const context = relevantChunks
      .map(c => `[Source: ${c.document_name} v${c.document_version}]\n${c.chunk_text}`)
      .join('\n\n---\n\n');
    
    const evidence: RAGEvidence[] = relevantChunks.map(c => ({
      document_id: c.document_id,
      document_name: c.document_name,
      document_version: c.document_version,
      chunk_text: c.chunk_text,
      chunk_index: c.chunk_index,
      similarity_score: c.similarity,
    }));
    
    return { context, evidence };
    
  } catch (error) {
    console.error('Error with pgvector retrieval:', error);
    // Fallback to JavaScript implementation
    return retrieveContext(query, agentId, tenantId, topK);
  }
}
